import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseFrontmatter, scanVault, searchVault, splitSections } from './knowledge-router.mjs';

async function makeFixture() {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-'));
  await mkdir(path.join(vault, 'Rokidシステム化'), { recursive: true });
  await mkdir(path.join(vault, 'Facebook投稿'), { recursive: true });
  await mkdir(path.join(vault, 'Clippings'), { recursive: true });
  await mkdir(path.join(vault, '旧資料'), { recursive: true });
  await mkdir(path.join(vault, '秘密'), { recursive: true });

  await writeFile(
    path.join(vault, 'Rokidシステム化', '検証.md'),
    '---\ntitle: "Rokid実機検証"\n---\n# 結果\nRokid実機で音声をMacへ送る試験に成功した。\n',
  );
  await writeFile(
    path.join(vault, 'Facebook投稿', '体験.md'),
    '# Rokidの体験\n私はRokid用カメラアプリを開発した。\n',
  );
  await writeFile(
    path.join(vault, 'Clippings', '他人の記事.md'),
    '---\ntags:\n  - clippings\n---\n# Rokid記事\n別の利用者がRokidでカメラアプリを作った。\n',
  );
  await writeFile(path.join(vault, '旧資料', '古い.md'), '# 古い\nRokidの古い推定。\n');
  await writeFile(
    path.join(vault, '秘密', '拒否.md'),
    '---\nai_access: deny\n---\n# 秘密\nRokidの秘密。\n',
  );
  await symlink(path.join(vault, 'Facebook投稿', '体験.md'), path.join(vault, 'Facebook投稿', 'リンク.md'));
  return vault;
}

test('frontmatterと本文を分離する', () => {
  const result = parseFrontmatter('---\ntitle: "テスト"\nai_access: allow\n---\n# 本文\n内容');
  assert.equal(result.properties.title, 'テスト');
  assert.equal(result.properties.ai_access, 'allow');
  assert.match(result.body, /# 本文/);
});

test('見出し単位で分割する', () => {
  const sections = splitSections('序文\n# 一\n内容1\n## 二\n内容2', 'ノート');
  assert.deepEqual(sections.map((section) => section.heading), ['ノート', '一', '二']);
});

test('frontmatterの一般的な日付欄と本文冒頭の更新日を記録日として扱う', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-document-date-'));
  await mkdir(path.join(vault, 'Facebook投稿'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Facebook投稿', '発見記録.md'),
      '---\ndiscovered: 2026-06-14\n---\n# Rokid\n本人記録。\n',
    );
    await writeFile(
      path.join(vault, 'Facebook投稿', '更新記録.md'),
      '# Rokid\n更新日: 2026-08-23\n本文。\n',
    );
    const scan = await scanVault(vault);
    const dates = Object.fromEntries(scan.documents.map((document) => [document.title, document.observedDate]));
    assert.equal(dates['発見記録'], '2026-06-14');
    assert.equal(dates['更新記録'], '2026-08-23');
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('旧資料、deny、シンボリックリンクを読まない', async () => {
  const vault = await makeFixture();
  try {
    const scan = await scanVault(vault);
    const paths = scan.documents.map((document) => document.relativePath);
    assert.equal(paths.length, 3);
    assert.equal(paths.some((item) => item.includes('旧資料')), false);
    assert.equal(paths.some((item) => item.includes('拒否.md')), false);
    assert.equal(paths.some((item) => item.includes('リンク.md')), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('本人の記録と外部資料を別の根拠として返す', async () => {
  const vault = await makeFixture();
  try {
    const result = await searchVault(vault, '私がRokidでどんなアプリを開発したか', {
      terms: ['Rokid', 'アプリ', '開発'],
      limit: 10,
    });
    const personal = result.candidates.find((candidate) => candidate.path.includes('Facebook投稿'));
    const reference = result.candidates.find((candidate) => candidate.path.includes('Clippings'));
    assert.equal(personal.evidenceRole, 'personal_evidence');
    assert.equal(reference.evidenceRole, 'reference_only');
    assert.ok(personal.score > reference.score);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('個人の経験を聞く時は外部資料を候補から外せる', async () => {
  const vault = await makeFixture();
  try {
    const result = await searchVault(vault, '私がRokidで何を作ったか', {
      terms: ['Rokid', 'アプリ'],
      evidenceRoles: ['personal_evidence', 'current_system_evidence'],
      limit: 10,
    });
    assert.equal(result.candidates.some((candidate) => candidate.evidenceRole === 'reference_only'), false);
    assert.equal(result.candidates.some((candidate) => candidate.evidenceRole === 'personal_evidence'), true);
    assert.equal(result.candidates.some((candidate) => candidate.evidenceRole === 'current_system_evidence'), true);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('必須の主体語を含まない候補を除外する', async () => {
  const vault = await makeFixture();
  try {
    await writeFile(path.join(vault, 'Facebook投稿', '無関係.md'), '# カメラ\nカメラアプリを開発した。\n');
    const result = await searchVault(vault, 'Rokidのアプリ開発', {
      terms: ['Rokid', 'アプリ', '開発'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['personal_evidence', 'current_system_evidence'],
      limit: 10,
    });
    assert.equal(result.candidates.some((candidate) => candidate.path.includes('無関係.md')), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('検証台帳を資料索引より優先する', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-priority-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 実機試験\nRokidの実機試験に合格した。\n',
    );
    await writeFile(
      path.join(vault, 'Rokidシステム化', '必須資料一覧.md'),
      '# 資料\nRokidの実機試験資料を列挙する。\n',
    );
    const result = await searchVault(vault, 'Rokidの実機試験', {
      terms: ['Rokid', '実機', '試験'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['current_system_evidence', 'reference_only'],
      limit: 2,
      perFileLimit: 1,
    });
    assert.match(result.candidates[0].path, /検証台帳\.md$/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('同じ台帳の古い未確認より後日の合格を優先する', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-timeline-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 実機試験\n' +
        '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
        '|---|---|---|---|\n' +
        '| 2026-08-21 | Rokid AIUI | 固定画面を作成 | 個人知識回答の実機往復は未確認 |\n' +
        '| 2026-08-23 | 結合準備 | Mac自動検査に合格 | Rokid AIUI個人知識回答の実機往復 |\n' +
        '| 2026-08-23 | Rokid AIUI | 個人知識回答の実機往復に合格 | 日常利用経路 |\n',
    );
    const result = await searchVault(vault, 'Rokid AIUIで現在実機で確かめたことは？', {
      terms: ['Rokid', 'AIUI', '個人知識', '実機'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['current_system_evidence'],
      timeScope: '現在（今日）',
      limit: 2,
      perFileLimit: 2,
    });
    assert.equal(result.candidates[0].observedDate, '2026-08-23');
    assert.match(result.candidates[0].excerpt, /確認できたこと: .*実機往復に合格/);
    assert.match(result.candidates[0].excerpt, /確認できていないこと: 日常利用経路/);
    assert.doesNotMatch(result.candidates[0].excerpt, /結合準備/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('同じ日付では古い版番号より後に追記した現在状態を優先する', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-same-day-current-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 個人AI進捗\n' +
        '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
        '|---|---|---|---|\n' +
        '| 2026-08-23 | 個人AI初版 | Rokid個人AIをv0.1.0で保存 | 自由質問 |\n' +
        '| 2026-08-23 | 固定経路 | Rokid固定経路に合格 | 自由質問 |\n' +
        '| 2026-08-23 | 現在状態 | RV101は自由質問の実機表示に合格 | 自由発話 |\n',
    );
    const result = await searchVault(vault, 'Rokidの個人AIづくり、今どこまで進んでいて次は何？', {
      terms: ['Rokid', '個人AI', '今', '次'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['current_system_evidence'],
      timeScope: '現在',
      limit: 2,
      perFileLimit: 2,
    });
    assert.match(result.candidates[0].excerpt, /自由質問の実機表示に合格/);
    assert.match(result.candidates[0].excerpt, /RV101/);
    assert.match(result.candidates[0].excerpt, /同日内の記録順: 3\/3/);
    assert.doesNotMatch(result.candidates[0].excerpt, /v0\.1\.0/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('最新の証拠保存行だけで直前の実体成功を隠さない', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-publication-context-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 個人AI進捗\n' +
        '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
        '|---|---|---|---|\n' +
        '| 2026-08-23 | 録音前準備 | Rokid個人AIのMac合成音声に合格 | 人声と実機表示 |\n' +
        '| 2026-08-23 | 利用者の自由発話 | RokidマイクからObsidian回答を実機表示して合格 | 複数の言い換え |\n' +
        '| 2026-08-23 | 実音声実機証拠v0.4.1保存 | 上の測定値と限界をGitHubへ匿名化保存 | 次の実音声 |\n',
    );
    const result = await searchVault(vault, 'Rokidで話した質問がObsidian回答としてもう実機で動いた？', {
      terms: ['Rokid', 'Obsidian', '実機', '回答'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['current_system_evidence'],
      timeScope: '現在',
      limit: 2,
      perFileLimit: 1,
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].recordOrder, 2);
    assert.match(result.candidates[0].excerpt, /RokidマイクからObsidian回答を実機表示して合格/);
    assert.match(result.candidates[0].excerpt, /GitHubへ匿名化保存/);
    assert.doesNotMatch(result.candidates[0].excerpt, /Mac合成音声に合格/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('広い現在質問では個人記事よりプロジェクトの現在要約を優先する', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-current-summary-'));
  await mkdir(path.join(vault, 'Rokidシステム化'), { recursive: true });
  await mkdir(path.join(vault, 'note投稿記事'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', 'README.md'),
      '# 現在の結論\n個人AIは実機経路に合格。次は録音なしで言い換えを検査する。\n',
    );
    await writeFile(
      path.join(vault, 'note投稿記事', '過去記事.md'),
      '# AI記事\n過去に一般的なAI活用記事を書いた。\n',
    );
    const result = await searchVault(vault, '私のAI作りは今どんな状態で、次は何？', {
      terms: ['AI', '今', '次'],
      requiredTerms: ['AI'],
      evidenceRoles: ['current_system_evidence', 'personal_evidence'],
      timeScope: '現在',
      limit: 2,
      perFileLimit: 1,
    });
    assert.match(result.candidates[0].path, /Rokidシステム化\/README\.md$/);
    assert.match(result.candidates[0].excerpt, /実機経路に合格/);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('現在要約がある時は同日文書内の古い途中記録を現在根拠へ混ぜない', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-current-stale-master-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', 'README.md'),
      '# 現在の結論\nRokid個人AIは利用者の実音声からRV101回答表示まで合格。次は候補確認画面。\n',
    );
    await writeFile(
      path.join(vault, 'Rokidシステム化', 'Rokidシステム構想書.md'),
      '# 途中記録\n更新日: 2026-08-23\nRokid個人AIは人の声とRV101表示がまだ未確認。\n',
    );
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 個人AI\n' +
        '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
        '|---|---|---|---|\n' +
        '| 2026-08-23 | 現在状態 | Rokid個人AIの実音声表示に合格 | 候補確認画面 |\n',
    );
    const result = await searchVault(vault, 'Rokid個人AIは今どこまで進んで次は何？', {
      terms: ['Rokid', '個人AI', '今', '次', '実音声'],
      requiredTerms: ['Rokid', '個人AI'],
      evidenceRoles: ['current_system_evidence'],
      timeScope: '現在',
      limit: 6,
      perFileLimit: 1,
    });
    assert.equal(result.candidates.some((candidate) => candidate.sourceKind === 'current_system_summary'), true);
    assert.equal(result.candidates.some((candidate) => candidate.sourceKind === 'system_master'), false);
    assert.equal(result.candidates.some((candidate) => /人の声とRV101表示がまだ未確認/.test(candidate.excerpt)), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('最初から現在までの質問では同じ台帳の複数時点を残す', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-timeline-range-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 個人AIの歩み\n' +
        '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
        '|---|---|---|---|\n' +
        '| 2026-08-21 | 初期方式 | RokidとMacの固定文字往復を設計 | 実音声 |\n' +
        '| 2026-08-22 | 中間段階 | Rokid音声をMac内Whisperで文字化 | 自由質問 |\n' +
        '| 2026-08-23 | 最新到達 | 利用者がRokidマイクへ発話し個人AI回答表示まで合格 | 騒音 |\n' +
        '| 2026-08-23 | 実音声証拠v0.4.1保存 | 上の結果をGitHubへ保存 | 次の実音声 |\n',
    );
    const result = await searchVault(vault, 'Rokid個人AIは最初から今日の実音声成功までどう進んだ？', {
      terms: ['Rokid', '個人AI', '実音声', 'Mac'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['current_system_evidence'],
      timeScope: '初期から現在まで',
      timeline: true,
      limit: 3,
      perFileLimit: 3,
    });
    assert.equal(result.candidates.length, 3);
    assert.equal(result.candidates[0].recordOrder, 2);
    assert.equal(new Set(result.candidates.map((candidate) => candidate.recordOrder)).size, 3);
    assert.equal(result.candidates.some((candidate) => /固定文字往復/.test(candidate.excerpt)), true);
    assert.equal(result.candidates.some((candidate) => /Rokidマイクへ発話し個人AI回答表示まで合格/.test(candidate.excerpt)), true);
    assert.equal(result.candidates.some((candidate) => /GitHubへ保存/.test(candidate.excerpt)), false);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('日付のない本人記録は相対表現だけを残し日付を推測しない', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-undated-personal-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  await mkdir(path.join(vault, 'Facebook投稿'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 個人AIの歩み\n' +
        '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
        '|---|---|---|---|\n' +
        '| 2026-08-21 | 初期方式 | RokidとMacの固定文字往復を設計 | 実音声 |\n' +
        '| 2026-08-23 | 最新到達 | Rokidマイクから個人AI回答表示まで合格 | 騒音 |\n',
    );
    await writeFile(
      path.join(vault, 'Facebook投稿', '途中の体験.md'),
      '# Rokid個人AIの体験\nその後、Obsidianを使って自分の記録から答える方式を試した。\n',
    );
    const result = await searchVault(vault, 'Rokid個人AIは最初から現在までどう進んだ？', {
      terms: ['Rokid', '個人AI', 'Obsidian', '最初', '現在'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['current_system_evidence', 'personal_evidence'],
      timeScope: '最初から現在まで',
      timeline: true,
      limit: 5,
      perFileLimit: 3,
    });
    const personal = result.candidates.find((candidate) => candidate.path.includes('途中の体験.md'));
    assert.ok(personal);
    assert.equal(personal.observedDate, null);
    assert.equal(personal.chronologyStatus, 'relative_only');
    assert.deepEqual(personal.chronologyMarkers, ['after']);
    const latest = result.candidates.find((candidate) => /個人AI回答表示まで合格/.test(candidate.excerpt));
    assert.equal(latest.observedDate, '2026-08-23');
    assert.equal(latest.chronologyStatus, 'dated');
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('現在質問では日付不明の現在主張より日付付き検証を優先する', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-router-undated-current-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  await mkdir(path.join(vault, 'Facebook投稿'), { recursive: true });
  try {
    await writeFile(
      path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
      '# 個人AI\n' +
        '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
        '|---|---|---|---|\n' +
        '| 2026-08-23 | 現在状態 | Rokid個人AIは実音声表示まで合格 | 書き込み |\n',
    );
    await writeFile(
      path.join(vault, 'Facebook投稿', '日付なし.md'),
      '# Rokid個人AI\n現在は固定文字しか使えず、実音声は未確認。\n',
    );
    const result = await searchVault(vault, 'Rokid個人AIの現在は？', {
      terms: ['Rokid', '個人AI', '現在', '実音声'],
      requiredTerms: ['Rokid'],
      evidenceRoles: ['current_system_evidence', 'personal_evidence'],
      timeScope: '現在',
      limit: 2,
      perFileLimit: 1,
    });
    assert.match(result.candidates[0].excerpt, /実音声表示まで合格/);
    assert.equal(result.candidates[0].observedDate, '2026-08-23');
    const undated = result.candidates.find((candidate) => candidate.path.includes('日付なし.md'));
    assert.equal(undated.chronologyStatus, 'relative_only');
    assert.deepEqual(undated.chronologyMarkers, ['current_claim']);
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});
