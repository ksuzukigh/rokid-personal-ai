import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runKnowledgePipeline,
  sanitizedEnvironment,
  spawnCapture,
} from '../knowledge-router/knowledge-pipeline.mjs';
import {
  DOCUMENT_TARGET_HINT,
  normalizeDocumentProposal,
} from './new-document-action.mjs';
import {
  OBSIDIAN_EDIT_TARGET_HINT,
} from './existing-document-edit.mjs';
import {
  GOOGLE_DRIVE_TARGET_HINT,
  normalizeGoogleDriveProposal,
} from './google-drive-action.mjs';
import {
  normalizeDocumentContext,
  normalizeInitialDocumentEditProposal,
} from './document-edit-planner.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT_DIR = path.dirname(MODULE_PATH);
const DEFAULT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_LOCAL_VAULT = '/path/to/your/ObsidianVault';
export const DEFAULT_ONE_TURN_AGENT_TIMEOUT_MS = 600_000;
const SCHEMA_PATH = path.join(PROJECT_DIR, 'one-turn-answer.schema.json');

export function normalizeOneTurnRequest(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text || text.length > 500) throw new Error('request must be 1 to 500 characters');
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error('request contains control characters');
  return text;
}

function makePrompt(request, { browserFallback = false, previousTurn = null } = {}) {
  const previousDocuments = previousTurn?.documentContext?.sources
    ?.map((source) => source.path)
    .join('、');
  const previousSection = previousTurn
    ? `\n直前の1往復（この質問に必要な場合だけ参照）:\n- 利用者: ${previousTurn.request}\n- 私のAI: ${previousTurn.answer}\n` +
      `${previousDocuments ? `- 直前に参照した文書: ${previousDocuments}\n` : ''}`
    : '\n直前の往復: なし\n';
  return `あなたはRokidの「私のAI」の第3段階です。利用者を固定コマンドや機能分類へ当てはめず、現在の自由な質問や依頼の目的を理解してください。

この段階の規則:
- 単語の出現で操作を選ばず、利用者が最終的に知りたいのか、文書を変えたいのか、新しく残したいのかを文全体から理解する。
- 現在の質問が主であり、直前の1往復は「その文書」「続き」「それ」などの指す先や追加質問の理解に必要な場合だけ使う。
- 現在の質問が単独で意味を持つ新しい話題なら、直前の内容を混ぜない。
- 直前の往復に書かれていない対象、作成物、実行結果を推測で補わない。
- 必要なら、現在利用できる読み取り専用のGoogle Drive検索・閲覧またはWeb検索を使ってよい。
- 最終的な目的がObsidian、自分のノート、Mac内の文書を読む、探す、内容を知る、要約することであり、文書を変える依頼ではない場合はoperation=consult_local_documentsとする。文書を変えたい依頼を、文中の「確認」などの単語だけで読み取り依頼にしない。
- operation=consult_local_documentsは元の依頼文を読み取り専用のLunaローカル文書検索へそのまま渡す内部計画である。answerには「文書を確認します」とだけ短く書く。直前の往復がなく「その文書」の対象が分からない場合だけ、operation=noneで題名または話題を1つ確認する。
- operation=consult_local_documentsではdocument_title、document_match_text、document_body、document_targetをすべて空文字にし、completed=trueとする。文書本文を推測で作らず、この段階でGoogle DriveやWebを検索しない。
- Obsidianや自分のノートと、Google DriveまたはWebのどれを探すのか曖昧な場合はoperation=noneとし、保存場所を一つ確認する。
- Web検索はOpenAIのネイティブWeb検索を優先する。それが利用できないか失敗した場合だけ、読み取り専用のブラウザで検索する。
- 利用者が「Webで」「ネットで」「インターネットで」と情報源を明示した場合、Google Driveやローカル資料をWeb調査の代わりにしない。必ずWebの現在情報を確認する。
- 検索が必要な依頼は、必要十分な根拠が揃ったら網羅だけを目的に調査を続けず、判断に役立つ答えを返す。
- 現在使える変更能力は、Obsidian内の専用保存先「${DOCUMENT_TARGET_HINT}」で、新しいMarkdown文書を一件作る候補、題名を指定した既存Markdown文書の末尾へ本文を追記する候補、Obsidian保管庫の既存Markdown文書で一意な現在文を新しい文へ置き換える候補、またはGoogle Drive内の専用保存先「${GOOGLE_DRIVE_TARGET_HINT}」へ新しいGoogleドキュメントを一件保存する候補を返すこと。このAI処理自体はファイルを書かない。
- 利用者が新規文書の作成とこの保存先を明確に依頼した場合だけ、operation=create_new_documentとする。document_titleは60文字以内でファイル名に使える題名、document_bodyは400文字以内の完成本文、document_targetは「${DOCUMENT_TARGET_HINT}」とする。
- operation=create_new_documentは保存済みという意味ではない。answerで題名と本文の要点を短く示し、Rokidの次の1回操作が保存確認であることを伝える。候補を用意できたらcompleted=trueとする。
- 利用者がこの保存先にある既存文書の題名と、末尾へ加える本文を明確に指定した場合だけ、operation=append_documentとする。document_titleは既存文書の題名、document_bodyは400文字以内の追記する完成本文、document_targetは「${DOCUMENT_TARGET_HINT}」とする。元の本文を要約、置換、削除、書き直ししない。
- operation=append_documentは追記済みという意味ではない。answerで追記先と追記内容の要点を短く示し、Rokidの次の1回操作が追記確認であることを伝える。候補を用意できたらcompleted=trueとする。
- 利用者がObsidianの既存文書の一部をどう直したいか理解できる場合は、固定した言い方や完全一致の題名を求めずoperation=replace_document_textとする。「その文書」などが直前の会話で特定できる場合は、直前に参照した文書を使いused_previous_turn=trueとする。
- operation=replace_document_textの各文書項目は実行値ではなく、次のLuna文書検索が実文書から対象と正確な現在文を決めるための初期理解である。document_titleは現在の依頼または直前の会話から分かる題名や手がかり、document_match_textは直したい部分の手がかり、document_bodyは望む変更後、document_targetは「${OBSIDIAN_EDIT_TARGET_HINT}」とする。意図が十分に分かればcompleted=trueとする。
- operation=replace_document_textは変更済みという意味ではない。answerで理解した対象と変更の要点を短く示し、Rokidの次の1回操作が変更確認であることを伝える。文書全体の書き直しや削除はまだ実行しない。
- 利用者がGoogle DriveまたはGoogleドキュメントへの新規文書保存と、題名・本文を明確に依頼した場合だけ、operation=save_document_to_google_driveとする。通常の「Google Driveへ保存」はGoogleドキュメント形式を意味する。document_titleは60文字以内の題名、document_bodyは400文字以内の完成本文、document_targetは「${GOOGLE_DRIVE_TARGET_HINT}」とする。
- operation=save_document_to_google_driveは保存済みという意味ではない。answerで題名と本文の要点を短く示し、Rokidの次の1回操作がGoogleドキュメント保存の確認であることを伝える。候補を用意できたらcompleted=trueとする。
- Google DriveへMarkdown形式で保存する依頼はまだ扱わない。Googleドキュメントへ勝手に置き換えず、operation=noneとして、現在はGoogleドキュメント形式だけ保存できるとanswerで伝える。
- 通常の質問や読み取り回答はoperation=noneとし、document_title、document_match_text、document_body、document_targetをすべて空文字にする。
- 文書全体の書き直し、文や文書の削除、移動、共有、送信、公開はまだ実行しない。現在の意図と直前の会話を読んでも対象や望む結果を一つに決められない場合だけ、operation=noneで確認を1つ返す。
- ローカルのシェルやファイル操作は使わない。
- 必要な読み取り能力が利用できなければ、できない理由を具体的にunavailable_reasonへ書く。
- answerはRV101で読める240文字以内。固定分類名や内部の道具名を利用者へ見せない。
- answerにURL、Markdown記法、途中で切れた文を入れない。出典に触れる場合は短い名前だけを自然な文で書く。
- used_previous_turnは、答えの対象や意味を決めるために直前の1往復を実際に使った場合だけtrueにする。参考に不要な新しい話題はfalse。
- 完了できた場合はcompleted=trueかつunavailable_reasonを空文字にする。
- 完了できない場合はcompleted=falseとし、answerにも何が不足したかを短く書く。

現在の利用者の自由な質問:
${request}${previousSection}${browserFallback ? '\n内部状態: OpenAIのネイティブWeb検索はこの質問ですでに失敗した。調査が必要なら、利用可能なPlaywrightの読み取り専用ブラウザを代替として使う。' : ''}`;
}

export function normalizePreviousTurn(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('previous turn must be an object');
  }
  const request = normalizeOneTurnRequest(value.request);
  const answer = String(value.answer ?? '').normalize('NFKC').trim();
  if (!answer || answer.length > 240 || /[\u0000-\u001f\u007f]/u.test(answer)) {
    throw new Error('previous turn answer must be 1 to 240 characters');
  }
  const documentContext = normalizeDocumentContext(value.documentContext);
  return Object.freeze({ request, answer, ...(documentContext ? { documentContext } : {}) });
}

export function collectOneTurnToolUsage(events) {
  const tools = [];
  for (const event of events) {
    if (event?.type !== 'item.completed') continue;
    const item = event.item ?? {};
    if (item.type === 'web_search' || item.type === 'web_search_call') {
      tools.push('openai/web_search');
      continue;
    }
    if (item.type !== 'mcp_tool_call') continue;
    const name = `${item.server ?? ''}/${item.tool ?? ''}`;
    tools.push(name);
  }
  return [...new Set(tools)];
}

function parseEvents(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function validateAnswer(value, { hasPreviousTurn = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('one-turn answer must be an object');
  }
  const answer = String(value.answer ?? '').normalize('NFKC').trim();
  const unavailableReason = String(value.unavailable_reason ?? '').normalize('NFKC').trim();
  const usedPreviousTurn = value.used_previous_turn;
  if (!answer || answer.length > 240) throw new Error('one-turn answer is invalid');
  if (unavailableReason.length > 240) throw new Error('one-turn unavailable reason is invalid');
  if (value.completed === true && unavailableReason) {
    throw new Error('completed one-turn answer cannot have an unavailable reason');
  }
  if (value.completed !== true && !unavailableReason) {
    throw new Error('incomplete one-turn answer requires an unavailable reason');
  }
  if (typeof usedPreviousTurn !== 'boolean') {
    throw new Error('one-turn answer requires previous-turn usage');
  }
  if (usedPreviousTurn && !hasPreviousTurn) {
    throw new Error('one-turn answer used missing previous turn');
  }
  const operation = String(value.operation ?? '');
  let documentProposal = null;
  if (operation === 'none') {
    if ([value.document_title, value.document_match_text, value.document_body, value.document_target]
      .some((item) => String(item ?? '') !== '')) {
      throw new Error('answer-only turn cannot contain a document proposal');
    }
  } else if (operation === 'consult_local_documents') {
    if (value.completed !== true || unavailableReason ||
        [value.document_title, value.document_match_text, value.document_body, value.document_target]
          .some((item) => String(item ?? '') !== '')) {
      throw new Error('local document consultation plan is invalid');
    }
  } else if (operation === 'replace_document_text') {
    if (value.completed !== true || unavailableReason) {
      throw new Error('document edit proposal must be complete before confirmation');
    }
    documentProposal = normalizeInitialDocumentEditProposal({
      title: value.document_title,
      matchText: value.document_match_text,
      replacementText: value.document_body,
      targetHint: value.document_target,
    });
  } else if (operation === 'create_new_document' || operation === 'append_document' ||
      operation === 'save_document_to_google_drive') {
    if (value.completed !== true || unavailableReason) {
      throw new Error('document proposal must be complete before confirmation');
    }
    const proposal = {
      title: value.document_title,
      body: value.document_body,
      targetHint: value.document_target,
    };
    if (String(value.document_match_text ?? '') !== '') {
      throw new Error('document proposal cannot contain match text');
    }
    documentProposal = operation === 'save_document_to_google_drive'
      ? normalizeGoogleDriveProposal(proposal)
      : normalizeDocumentProposal(proposal);
  } else {
    throw new Error('one-turn operation is invalid');
  }
  return {
    answer,
    completed: value.completed === true,
    unavailableReason,
    usedPreviousTurn,
    operation,
    documentProposal,
  };
}

export function createOneTurnAgent(options = {}) {
  const executable = options.executable ?? DEFAULT_CODEX;
  const model = options.model ?? DEFAULT_MODEL;
  const runProcess = options.runProcess ?? spawnCapture;
  const localKnowledge = options.localKnowledge ?? runKnowledgePipeline;
  const localVaultPath = options.localVaultPath ?? DEFAULT_LOCAL_VAULT;

  return async function answerOneTurn(input) {
    const request = normalizeOneTurnRequest(input?.request);
    const previousTurn = normalizePreviousTurn(input?.previousTurn);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rokid-one-turn-agent-'));
    const outputPath = path.join(temporaryDirectory, 'answer.json');
    let localDocumentConsultationAttempted = false;
    try {
      let nativeResult = null;
      try {
        nativeResult = await runAttempt({ browserFallback: false });
        if (nativeResult.completed || localDocumentConsultationAttempted) return nativeResult;
      } catch (error) {
        if (input?.signal?.aborted || error?.name === 'AbortError') throw error;
      }
      try {
        return await runAttempt({ browserFallback: true });
      } catch (error) {
        if (nativeResult) return nativeResult;
        throw error;
      }
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }

    async function runAttempt({ browserFallback }) {
      await fs.rm(outputPath, { force: true });
      const browserControls = browserFallback ? [
        '--config', 'mcp_servers.node_repl.enabled=false',
      ] : [
        '--config', 'mcp_servers.playwright.enabled=false',
        '--config', 'mcp_servers.node_repl.enabled=false',
      ];
      const result = await runProcess(executable, [
        '--search',
        ...browserControls,
        'exec',
        '--approve-for-me',
        '--model', model,
        '--ephemeral',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--json',
        '--output-schema', SCHEMA_PATH,
        '--output-last-message', outputPath,
        '-',
      ], {
        cwd: temporaryDirectory,
        env: sanitizedEnvironment(options.environment ?? process.env),
        input: makePrompt(request, { browserFallback, previousTurn }),
        timeoutMs: options.timeoutMs ?? DEFAULT_ONE_TURN_AGENT_TIMEOUT_MS,
        // Native Web search events include source metadata and can exceed the
        // generic 2 MB capture ceiling even though the final RV101 answer is
        // still capped at 240 characters.
        maximumBytes: options.maximumBytes ?? 20_000_000,
        signal: input?.signal,
      });
      if (result.code !== 0) throw new Error(`one-turn Codex failed with exit ${result.code}`);
      const events = parseEvents(result.stdout);
      const tools = collectOneTurnToolUsage(events);
      const value = validateAnswer(JSON.parse(await fs.readFile(outputPath, 'utf8')), {
        hasPreviousTurn: previousTurn !== null,
      });
      if (value.operation === 'consult_local_documents') {
        localDocumentConsultationAttempted = true;
        if (tools.length) {
          return localDocumentFailure(value, tools, 'ローカル文書の読み取り専用処理を開始できませんでした');
        }
        try {
          const localResult = await localKnowledge({
            question: request,
            vaultPath: localVaultPath,
            answerCharacterLimit: 240,
            allowSensitive: false,
            signal: input?.signal,
          });
          const localAnswer = String(localResult?.answer?.text ?? '').normalize('NFKC').trim();
          if (!localAnswer || localAnswer.length > 240) throw new Error('local document answer is invalid');
          const documentContext = Array.isArray(localResult.documentSources) && localResult.documentSources.length
            ? normalizeDocumentContext({ sources: localResult.documentSources })
            : null;
          return {
            ...value,
            answer: localAnswer,
            operation: 'none',
            documentProposal: null,
            requestHandledAs: 'free_conversation_turn',
            tools: ['local/obsidian-readonly'],
            changed: false,
            ephemeral: true,
            auth: 'ChatGPT',
            ...(documentContext ? { documentContext } : {}),
          };
        } catch (error) {
          if (input?.signal?.aborted || error?.name === 'AbortError') throw error;
          return localDocumentFailure(value, ['local/obsidian-readonly'],
            '読み取り可能な文書を特定できませんでした');
        }
      }
      return {
        ...value,
        requestHandledAs: 'free_conversation_turn',
        tools,
        changed: false,
        ephemeral: true,
        auth: 'ChatGPT',
      };
    }

    function localDocumentFailure(value, tools, unavailableReason) {
      return {
        ...value,
        answer: '指定された文書を確認できませんでした。文書は変更していません。',
        completed: false,
        unavailableReason,
        operation: 'none',
        documentProposal: null,
        requestHandledAs: 'free_conversation_turn',
        tools,
        changed: false,
        ephemeral: true,
        auth: 'ChatGPT',
      };
    }
  };
}

export const answerOneTurn = createOneTurnAgent();

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const request = process.argv.slice(2).join(' ');
  if (!request) {
    console.error('Usage: node one-turn-agent.mjs <free request>');
    process.exitCode = 2;
  } else {
    try {
      const result = await createOneTurnAgent()({ request });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      console.error(`ONE_TURN_FAILED ${error.message}`);
      process.exitCode = 2;
    }
  }
}
