import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  runKnowledgePipeline,
  sanitizedEnvironment,
  selectTransmittableSources,
  validateSearchPlan,
} from './knowledge-pipeline.mjs';

test('Luna子処理へAPIキーと中継認証を引き継がない', () => {
  const environment = sanitizedEnvironment({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'api-secret',
    CODEX_API_KEY: 'codex-secret',
    OPENAI_BASE_URL: 'https://example.invalid',
    ROKID_KNOWLEDGE_TOKEN: 'relay-secret',
    ROKID_KNOWLEDGE_QUESTION: 'private session question',
    ROKID_VOICE_KNOWLEDGE_TOKEN: 'voice-relay-secret',
    ROKID_AUDIO_RELAY_TOKEN: 'legacy-audio-secret',
    ROKID_READONLY_VOICE_TOKEN: 'legacy-readonly-secret',
    ROKID_CLOUDFLARED_CONFIG: '/secret/config.yml',
    ROKID_DAILY_SESSION_TOKEN: 'daily-session-secret',
    ROKID_DAILY_SESSION_PORT: '18448',
    ROKID_DAILY_SESSION_TTL_MS: '300000',
  });
  assert.deepEqual(environment, { PATH: '/usr/bin' });
});

test('検索計画の件数と根拠種別を検査する', () => {
  const plan = validateSearchPlan({
    answerable: true,
    subject: 'Rokid',
    time_scope: 'これまで',
    search_terms: ['Rokid', '実機', '開発'],
    required_terms: ['Rokid'],
    evidence_roles: ['personal_evidence', 'current_system_evidence'],
    sensitivity: 'low',
    reason: '本人の開発履歴を探す',
  });
  assert.deepEqual(plan.requiredTerms, ['Rokid']);
  assert.throws(
    () =>
      validateSearchPlan({
        answerable: true,
        subject: 'Rokid',
        time_scope: 'これまで',
        search_terms: ['Rokid'],
        required_terms: ['Rokid'],
        evidence_roles: ['unknown'],
        sensitivity: 'low',
        reason: '不正な計画',
      }),
    /at least two|unsupported/,
  );
});

test('confirmと上限超過の抜粋をAI送信候補から外す', () => {
  const result = selectTransmittableSources(
    {
      candidates: [
        { path: '許可.md', section: '一', excerpt: '短い', sendPolicy: 'allow' },
        { path: '確認.md', section: '二', excerpt: '秘密', sendPolicy: 'confirm' },
        { path: '長い.md', section: '三', excerpt: 'x'.repeat(20), sendPolicy: 'allow' },
      ],
    },
    { maximumSources: 2, maximumExcerptCharacters: 10 },
  );
  assert.deepEqual(result.sent.map((item) => item.path), ['許可.md']);
  assert.deepEqual(result.withheld.map((item) => item.reason), ['confirm', 'excerpt_budget']);
});

test('質問だけの計画と許可抜粋だけの回答を二段階で作る', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-pipeline-test-'));
  await mkdir(path.join(vault, 'Facebook投稿'));
  await mkdir(path.join(vault, 'FBアーカイブ'));
  await writeFile(
    path.join(vault, 'Facebook投稿', 'Rokid開発.md'),
    '# 開発\n私はRokid用のカメラアプリを開発し、実機試験をした。\n',
  );
  await writeFile(
    path.join(vault, 'FBアーカイブ', '過去.md'),
    '# 秘密の履歴\nRokidの過去の非公開記録。\n',
  );
  const prompts = [];
  const signal = new AbortController().signal;
  const modelRunner = async ({ stage, prompt, signal: receivedSignal }) => {
    assert.equal(receivedSignal, signal);
    prompts.push({ stage, prompt });
    if (stage === 'search-plan') {
      return {
        value: {
          answerable: true,
          subject: 'Rokid',
          time_scope: 'これまで',
          search_terms: ['Rokid', 'カメラ', '開発', '実機'],
          required_terms: ['Rokid'],
          evidence_roles: ['personal_evidence', 'historical_personal_evidence'],
          sensitivity: 'low',
          reason: '本人の記録を探す',
        },
        audit: { stage, toolUse: false },
      };
    }
    return {
      value: {
        answer: 'Rokid用カメラアプリを開発し、実機試験をしています。',
        citations: [{ source_id: 'S1', claim: 'カメラアプリの開発と実機試験' }],
        confidence: 'high',
        missing_information: [],
      },
      audit: { stage, toolUse: false },
    };
  };

  try {
    const result = await runKnowledgePipeline({
      vaultPath: vault,
      question: '私はRokidで何を開発した？',
      modelRunner,
      signal,
      answerCharacterLimit: 160,
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0].prompt, /私はRokidで何を開発した/);
    assert.doesNotMatch(prompts[0].prompt, /カメラアプリを開発し/);
    assert.match(prompts[1].prompt, /カメラアプリを開発し/);
    assert.match(prompts[1].prompt, /160文字以内/);
    assert.doesNotMatch(prompts[1].prompt, /秘密の履歴/);
    assert.equal(result.transmission.sent.length, 1);
    assert.equal(result.transmission.withheld[0].reason, 'confirm');
    assert.equal(result.answer.citations[0].path, 'Facebook投稿/Rokid開発.md');
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('Rokid表示用の文字数上限を超えた回答を拒否する', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-pipeline-length-'));
  await mkdir(path.join(vault, 'Rokidシステム化'));
  await writeFile(path.join(vault, 'Rokidシステム化', '正本.md'), '# Rokid\n実機試験に合格。\n');
  const modelRunner = async ({ stage }) => {
    if (stage === 'search-plan') {
      return {
        value: {
          answerable: true,
          subject: 'Rokid',
          time_scope: '現在',
          search_terms: ['Rokid', '実機'],
          required_terms: ['Rokid'],
          evidence_roles: ['current_system_evidence'],
          sensitivity: 'low',
          reason: '正本を探す',
        },
        audit: { stage },
      };
    }
    return {
      value: {
        answer: '長'.repeat(161),
        citations: [{ source_id: 'S1', claim: '実機試験' }],
        confidence: 'high',
        missing_information: [],
      },
      audit: { stage },
    };
  };
  try {
    await assert.rejects(
      runKnowledgePipeline({
        vaultPath: vault,
        question: 'Rokidの実機試験は？',
        modelRunner,
        answerCharacterLimit: 160,
      }),
      /exceeds 160 characters/,
    );
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('存在しない根拠IDを回答が引用したら拒否する', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-pipeline-citation-'));
  await mkdir(path.join(vault, 'Rokidシステム化'));
  await writeFile(path.join(vault, 'Rokidシステム化', '正本.md'), '# Rokid\nRokidの実機結果。\n');
  const modelRunner = async ({ stage }) => {
    if (stage === 'search-plan') {
      return {
        value: {
          answerable: true,
          subject: 'Rokid',
          time_scope: '現在',
          search_terms: ['Rokid', '実機'],
          required_terms: ['Rokid'],
          evidence_roles: ['current_system_evidence'],
          sensitivity: 'low',
          reason: '正本を探す',
        },
        audit: { stage },
      };
    }
    return {
      value: {
        answer: '回答',
        citations: [{ source_id: 'S6', claim: '架空' }],
        confidence: 'low',
        missing_information: [],
      },
      audit: { stage },
    };
  };
  try {
    await assert.rejects(
      runKnowledgePipeline({ vaultPath: vault, question: 'Rokidの実機結果は？', modelRunner }),
      /unknown source S6/,
    );
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('機密度highは明示許可なしに検索へ進めない', async () => {
  let calls = 0;
  const modelRunner = async ({ stage }) => {
    calls += 1;
    assert.equal(stage, 'search-plan');
    return {
      value: {
        answerable: true,
        subject: '個人情報',
        time_scope: '現在',
        search_terms: ['住所', '連絡先'],
        required_terms: [],
        evidence_roles: ['personal_evidence'],
        sensitivity: 'high',
        reason: '機密性の高い個人情報',
      },
      audit: { stage },
    };
  };
  await assert.rejects(
    runKnowledgePipeline({
      vaultPath: '/検索されてはいけない',
      question: '私の住所と連絡先は？',
      modelRunner,
    }),
    /requires explicit approval/,
  );
  assert.equal(calls, 1);
});

test('日付不明の本人記録をLunaへ明示し推測禁止を伝える', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'knowledge-pipeline-undated-'));
  await mkdir(path.join(vault, 'Rokidシステム化', '検証'), { recursive: true });
  await mkdir(path.join(vault, 'Facebook投稿'), { recursive: true });
  await writeFile(
    path.join(vault, 'Rokidシステム化', '検証', '検証台帳.md'),
    '# Rokid個人AI\n' +
      '| 日付 | 項目 | 確認できたこと | 確認できていないこと |\n' +
      '|---|---|---|---|\n' +
      '| 2026-08-21 | 初期 | 固定文字を確認 | 実音声 |\n' +
      '| 2026-08-23 | 最新 | 実音声の回答表示に合格 | 書き込み |\n',
  );
  await writeFile(
    path.join(vault, 'Facebook投稿', '途中の記録.md'),
    '# Rokid個人AI\nその後、Obsidianで本人記録を探す方式を試した。\n',
  );
  const modelRunner = async ({ stage, prompt }) => {
    if (stage === 'search-plan') {
      return {
        value: {
          answerable: true,
          subject: 'Rokid個人AI',
          time_scope: '最初から現在まで',
          search_terms: ['Rokid', '個人AI', 'Obsidian', '実音声'],
          required_terms: ['Rokid'],
          evidence_roles: ['current_system_evidence', 'personal_evidence'],
          sensitivity: 'low',
          reason: '本人記録と検証履歴を探す',
        },
        audit: { stage },
      };
    }
    assert.match(prompt, /途中の記録\.md/);
    assert.match(prompt, /時系列情報: 記録日不明・相対表現だけ（after）/);
    assert.match(prompt, /記録日不明の抜粋へ日付を推測で付けない/);
    const undatedSourceId = prompt.match(/\[(S\d+)\]\nファイル: Facebook投稿\/途中の記録\.md/)?.[1];
    assert.ok(undatedSourceId);
    return {
      value: {
        answer: '初期確認後、記録日不明の本人記録ではObsidian検索を試し、2026-08-23に実音声表示へ到達した。',
        citations: [{ source_id: undatedSourceId, claim: '日付不明の途中記録' }],
        confidence: 'medium',
        missing_information: ['日付不明の本人記録と別文書の正確な順序'],
      },
      audit: { stage },
    };
  };
  try {
    const result = await runKnowledgePipeline({
      vaultPath: vault,
      question: 'Rokid個人AIは最初から現在までどう進んだ？',
      modelRunner,
    });
    assert.equal(result.answer.confidence, 'medium');
    assert.match(result.answer.missingInformation[0], /正確な順序/);
    assert.equal(
      result.transmission.sent.some((source) => source.chronologyStatus === 'relative_only'),
      true,
    );
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});
