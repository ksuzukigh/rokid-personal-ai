import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { candidateConfirmationBinding } from '../action-candidate/confirmation-ticket.mjs';
import {
  createReplaceDocumentTextCandidate,
  OBSIDIAN_EDIT_TARGET_HINT,
  replaceExistingDocumentText,
} from './existing-document-edit.mjs';

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'rokid-document-edit-'));
  const vault = path.join(parent, '保管庫');
  const folder = path.join(vault, '検証');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, '検証台帳.md');
  await writeFile(file, '# 検証台帳\n\n状態は未確認です。\n', { mode: 0o600 });
  return { parent, vault, file };
}

function proposal() {
  return {
    title: '検証台帳',
    matchText: '状態は未確認です。',
    replacementText: '状態は実機合格です。',
    targetHint: OBSIDIAN_EDIT_TARGET_HINT,
  };
}

test('題名と現在文と変更後文を実文書の版に結び付ける', async () => {
  const item = await fixture();
  try {
    const candidate = await createReplaceDocumentTextCandidate({
      request: '検証台帳の未確認を実機合格に変えて',
      proposal: proposal(),
      vaultRoot: item.vault,
      allowedParent: item.parent,
      candidateId: 'edit-candidate-01',
    });
    assert.equal(candidate.actionType, 'replace_document_text');
    assert.equal(candidate.targetHint, '検証/検証台帳.md');
    assert.match(candidate.payloadPreview, /現在:\n状態は未確認/);
    assert.match(candidate.payloadPreview, /変更後:\n状態は実機合格/);
    assert.match(candidate.resourceVersion, /^[a-f0-9]{64}$/u);
    assert.equal(await readFile(item.file, 'utf8'), '# 検証台帳\n\n状態は未確認です。\n');
  } finally {
    await rm(item.parent, { recursive: true, force: true });
  }
});

test('Lunaが検索候補から決めた相対パスを文書の実体に結び付ける', async () => {
  const item = await fixture();
  try {
    const candidate = await createReplaceDocumentTextCandidate({
      request: 'Obsidianの検証台帳の未確認を実機合格に変えて',
      proposal: {
        ...proposal(),
        title: 'Obsidianの検証台帳',
        resolvedPath: '検証/検証台帳.md',
      },
      vaultRoot: item.vault,
      allowedParent: item.parent,
      candidateId: 'edit-candidate-location-prefix',
    });
    assert.equal(candidate.summary, '既存文書「検証台帳」の一箇所を変更');
    assert.equal(candidate.targetHint, '検証/検証台帳.md');
    assert.match(candidate.payloadPreview, /^文書: 検証台帳$/mu);
  } finally {
    await rm(item.parent, { recursive: true, force: true });
  }
});

test('検索で決めたパスが保管庫外またはMarkdown以外なら拒否する', async () => {
  const item = await fixture();
  try {
    await assert.rejects(() => createReplaceDocumentTextCandidate({
      request: '文書を更新して',
      proposal: { ...proposal(), resolvedPath: '../外部.md' },
      vaultRoot: item.vault, allowedParent: item.parent,
    }), /resolved document path is invalid/);
  } finally {
    await rm(item.parent, { recursive: true, force: true });
  }
});

test('確認した一箇所だけを一回置き換える', async () => {
  const item = await fixture();
  try {
    const candidate = await createReplaceDocumentTextCandidate({
      request: '検証台帳を更新して', proposal: proposal(),
      vaultRoot: item.vault, allowedParent: item.parent,
    });
    const binding = candidateConfirmationBinding(candidate);
    const result = await replaceExistingDocumentText(candidate, {
      authorized: true,
      executionCapability: 'replace_document_text',
      candidateId: binding.candidateId,
      candidateDigest: binding.digest,
    }, { vaultRoot: item.vault, allowedParent: item.parent });
    assert.equal(result.applied, true);
    assert.equal(result.state, 'text_replaced');
    assert.equal(await readFile(item.file, 'utf8'), '# 検証台帳\n\n状態は実機合格です。\n');
    await assert.rejects(
      () => replaceExistingDocumentText(candidate, {
        authorized: true,
        executionCapability: 'append_document',
        candidateId: binding.candidateId,
        candidateDigest: binding.digest,
      }, { vaultRoot: item.vault, allowedParent: item.parent }),
      /authorization is required/,
    );
  } finally {
    await rm(item.parent, { recursive: true, force: true });
  }
});

test('確認中の文書変更、重複題名、重複文、シンボリックリンクを変更しない', async () => {
  const item = await fixture();
  try {
    const candidate = await createReplaceDocumentTextCandidate({
      request: '検証台帳を更新して', proposal: proposal(),
      vaultRoot: item.vault, allowedParent: item.parent,
    });
    const binding = candidateConfirmationBinding(candidate);
    await writeFile(item.file, '# 検証台帳\n\n確認中に変わりました。\n');
    const changed = await replaceExistingDocumentText(candidate, {
      authorized: true,
      executionCapability: 'replace_document_text',
      candidateId: binding.candidateId,
      candidateDigest: binding.digest,
    }, { vaultRoot: item.vault, allowedParent: item.parent });
    assert.deepEqual(changed, {
      applied: false, changed: false, state: 'document_changed', title: '検証台帳',
    });

    await writeFile(item.file, '# 検証台帳\n\n状態は未確認です。状態は未確認です。\n');
    await assert.rejects(() => createReplaceDocumentTextCandidate({
      request: '更新', proposal: proposal(), vaultRoot: item.vault, allowedParent: item.parent,
    }), (error) => error?.code === 'DOCUMENT_TEXT_AMBIGUOUS');

    const duplicate = path.join(item.vault, '別フォルダ');
    await mkdir(duplicate);
    await writeFile(path.join(duplicate, '検証台帳.md'), '状態は未確認です。');
    await assert.rejects(() => createReplaceDocumentTextCandidate({
      request: '更新', proposal: proposal(), vaultRoot: item.vault, allowedParent: item.parent,
    }), (error) => error?.code === 'DOCUMENT_AMBIGUOUS');

    const outside = path.join(item.parent, '外部.md');
    await writeFile(outside, '状態は未確認です。');
    await symlink(outside, path.join(item.vault, '外部.md'));
    await assert.rejects(() => createReplaceDocumentTextCandidate({
      request: '更新',
      proposal: { ...proposal(), title: '外部' },
      vaultRoot: item.vault,
      allowedParent: item.parent,
    }), (error) => error?.code === 'DOCUMENT_NOT_FOUND');
  } finally {
    await rm(item.parent, { recursive: true, force: true });
  }
});
