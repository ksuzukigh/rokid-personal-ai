import { createOneTurnAgent } from './one-turn-agent.mjs';
import {
  createGoogleDriveCandidate,
  createGoogleDriveClient,
  DEFAULT_GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_DRIVE_TARGET_HINT,
} from './google-drive-action.mjs';

const title = 'Drive保存候補';
const body = 'これはGoogle Driveへ保存する前の候補確認です。';
const drive = createGoogleDriveClient();
const before = await drive.listFolder(DEFAULT_GOOGLE_DRIVE_FOLDER_ID);
const request = `「${title}」という新しい文書をGoogle Driveへ保存して。本文は「${body}」にして。`;
const result = await createOneTurnAgent()({ request });
if (result.operation !== 'save_document_to_google_drive' || result.changed !== false ||
    result.documentProposal?.title !== title ||
    result.documentProposal?.body !== body ||
    result.documentProposal?.targetHint !== GOOGLE_DRIVE_TARGET_HINT) {
  throw new Error('real agent did not return the exact unexecuted Google Drive proposal');
}
const candidate = createGoogleDriveCandidate({ request, proposal: result.documentProposal });
const after = await drive.listFolder(DEFAULT_GOOGLE_DRIVE_FOLDER_ID);
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error('Google Drive target changed during proposal-only preflight');
}
if (candidate.actionType !== 'save_document_to_google_drive' || candidate.changed !== false) {
  throw new Error('Google Drive candidate was not an unexecuted preview');
}

process.stdout.write(`${JSON.stringify({
  operation: result.operation,
  title,
  targetHint: result.documentProposal.targetHint,
  candidatePrepared: true,
  actualTargetUnchanged: true,
  fileCount: after.length,
}, null, 2)}\n`);
