import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = path.join(PROJECT_DIR, 'source-policy.json');

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP');
}

function stripYamlScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractDates(value) {
  const normalized = String(value ?? '').normalize('NFKC');
  const dates = [];
  const pattern = /\b(20\d{2})[-/.\u5e74](\d{1,2})[-/.\u6708](\d{1,2})(?:\u65e5)?\b/g;
  for (const match of normalized.matchAll(pattern)) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    dates.push(`${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return dates;
}

function latestDate(...values) {
  const dates = values.flatMap(extractDates);
  return dates.length ? dates.sort().at(-1) : null;
}

function explicitDocumentDate(body) {
  const header = String(body).replaceAll('\r\n', '\n').split('\n').slice(0, 40).join('\n');
  const values = [];
  for (const match of header.matchAll(/^(?:更新日|作成日|記録日|date|updated):\s*(.+)$/gim)) {
    values.push(match[1]);
  }
  return latestDate(values);
}

function chronologyMetadata(observedDate, text) {
  if (observedDate) {
    return { chronologyStatus: 'dated', chronologyMarkers: [] };
  }
  const normalized = normalizeText(text);
  const markers = [];
  const patterns = [
    ['before', /当初|最初|初期|それ以前|その前/],
    ['after', /その後|続いて|次に|のあと|後に/],
    ['current_claim', /現在|現時点|いま|今は|今日/],
  ];
  for (const [name, pattern] of patterns) {
    if (pattern.test(normalized)) markers.push(name);
  }
  return {
    chronologyStatus: markers.length ? 'relative_only' : 'undated',
    chronologyMarkers: markers,
  };
}

export function parseFrontmatter(markdown) {
  const normalized = String(markdown).replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) {
    return { properties: {}, body: normalized };
  }

  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    return { properties: {}, body: normalized };
  }

  const yaml = normalized.slice(4, end);
  const properties = {};
  for (const line of yaml.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!match) continue;
    properties[match[1]] = stripYamlScalar(match[2]);
  }
  return { properties, body: normalized.slice(end + 5) };
}

function chunkLongSection(section, maxChars = 3600) {
  if (section.text.length <= maxChars) return [section];

  const paragraphs = section.text.split(/\n\s*\n/);
  const chunks = [];
  let current = '';
  let part = 1;
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      chunks.push({ ...section, heading: `${section.heading} (${part})`, text: current });
      part += 1;
      current = '';
    }
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push({ ...section, heading: `${section.heading} (${part})`, text: current });
        part += 1;
        current = '';
      }
      for (let offset = 0; offset < paragraph.length; offset += maxChars) {
        chunks.push({
          ...section,
          heading: `${section.heading} (${part})`,
          text: paragraph.slice(offset, offset + maxChars),
        });
        part += 1;
      }
      continue;
    }
    current += `${current ? '\n\n' : ''}${paragraph}`;
  }
  if (current) chunks.push({ ...section, heading: `${section.heading} (${part})`, text: current });
  return chunks;
}

export function splitSections(body, title = '本文') {
  const lines = String(body).replaceAll('\r\n', '\n').split('\n');
  const sections = [];
  let heading = title || '本文';
  let buffer = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) sections.push({ heading, text });
    buffer = [];
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match) {
      flush();
      heading = match[2];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections.flatMap(splitDatedTableRows).flatMap((section) => chunkLongSection(section));
}

function splitDatedTableRows(section) {
  const lines = section.text.split('\n');
  const datedRows = [];
  const narrative = [];
  const headerLine = lines.find((line) =>
    /^\s*\|/.test(line) && !/^\s*\|\s*20\d{2}-/.test(line) && !/^\s*\|\s*:?-+/.test(line),
  );
  const headers = headerLine ? parseTableCells(headerLine) : [];
  for (const line of lines) {
    const match = line.match(/^\s*\|\s*(20\d{2}-\d{1,2}-\d{1,2})\s*\|/);
    if (match) {
      const observedDate = latestDate(match[1]);
      const cells = parseTableCells(line);
      const fields = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
      const labeledText = headers.length === cells.length
        ? headers.map((header, index) => `${header}: ${cells[index]}`).join('\n')
        : line.trim();
      datedRows.push({
        ...section,
        heading: `${section.heading} (${observedDate})`,
        text: labeledText,
        observedDate,
        itemText: fields['\u9805\u76ee'] ?? '',
        verifiedText: fields['\u78ba\u8a8d\u3067\u304d\u305f\u3053\u3068'] ?? '',
        unverifiedText: fields['\u78ba\u8a8d\u3067\u304d\u3066\u3044\u306a\u3044\u3053\u3068'] ?? '',
        recordOrder: datedRows.length,
      });
    } else if (!/^\s*\|/.test(line)) {
      narrative.push(line);
    }
  }
  if (!datedRows.length) return [section];
  const narrativeText = narrative.join('\n').trim();
  const orderedRows = datedRows.map((row) => ({ ...row, recordCount: datedRows.length }));
  return [...(narrativeText ? [{ ...section, text: narrativeText }] : []), ...orderedRows];
}

function parseTableCells(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

export async function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return JSON.parse(await fs.readFile(policyPath, 'utf8'));
}

export function classifyPath(relativePath, policy) {
  const normalizedPath = relativePath.split(path.sep).join('/').normalize('NFKC');
  const rule = policy.rules.find((candidate) =>
    normalizedPath.startsWith(candidate.prefix.normalize('NFKC')),
  );
  return { ...(rule ?? policy.fallback) };
}

function applyAccessOverride(classification, properties) {
  const override = normalizeText(properties.ai_access);
  if (!['allow', 'confirm', 'deny'].includes(override)) return classification;
  return { ...classification, sendPolicy: override };
}

function includesExcludedSegment(relativePath, policy) {
  const excluded = new Set(policy.excludedSegments.map((segment) => segment.normalize('NFKC')));
  const segments = relativePath.split(path.sep).map((segment) => segment.normalize('NFKC'));
  return segments.some((segment) => excluded.has(segment));
}

async function collectMarkdownFiles(directory, vaultRoot, policy, output) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(vaultRoot, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || includesExcludedSegment(relativePath, policy)) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectMarkdownFiles(absolutePath, vaultRoot, policy, output);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLocaleLowerCase() !== '.md') continue;
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || stat.size > policy.maxFileBytes) continue;
    output.push({ absolutePath, relativePath, size: stat.size, modifiedMs: stat.mtimeMs });
  }
}

export async function scanVault(vaultPath, options = {}) {
  const policy = options.policy ?? (await loadPolicy(options.policyPath));
  const vaultRoot = await fs.realpath(vaultPath);
  const files = [];
  await collectMarkdownFiles(vaultRoot, vaultRoot, policy, files);

  const documents = [];
  for (const file of files) {
    const markdown = await fs.readFile(file.absolutePath, 'utf8');
    const { properties, body } = parseFrontmatter(markdown);
    let classification = classifyPath(file.relativePath, policy);
    classification = applyAccessOverride(classification, properties);
    if (classification.sendPolicy === 'deny') continue;
    const title = properties.title || path.basename(file.relativePath, '.md');
    documents.push({
      ...file,
      title,
      properties,
      observedDate: latestDate(
        Object.values(properties),
        file.relativePath,
        explicitDocumentDate(body),
      ),
      ...classification,
      sections: splitSections(body, title),
    });
  }

  return { vaultRoot, policy, documents };
}

const JAPANESE_STOP_PHRASES = new Set([
  'これまで',
  'どんな',
  'どのような',
  '教えて',
  '知りたい',
  'について',
  'しました',
  'してきた',
]);

function extractTerms(query, extraTerms = []) {
  const normalizedQuery = normalizeText(query);
  const terms = new Set(extraTerms.map(normalizeText).filter(Boolean));
  for (const token of normalizedQuery.match(/[a-z0-9][a-z0-9_.+-]{1,}|[一-鿿゠-ヿぁ-ゟ]{2,}/g) ?? []) {
    if (token.length <= 12 && !JAPANESE_STOP_PHRASES.has(token)) terms.add(token);
  }
  if (terms.has('rokid')) terms.add('rv101');
  if (terms.has('rv101')) terms.add('rokid');
  return [...terms].sort((a, b) => b.length - a.length);
}

function trigrams(value) {
  const compact = normalizeText(value).replace(/[\s\p{P}\p{S}]+/gu, '');
  if (compact.length < 3) return compact ? new Set([compact]) : new Set();
  const result = new Set();
  for (let index = 0; index <= compact.length - 3; index += 1) {
    result.add(compact.slice(index, index + 3));
  }
  return result;
}

function overlapScore(queryTrigrams, text) {
  if (queryTrigrams.size === 0) return 0;
  const candidate = trigrams(text);
  let overlap = 0;
  for (const gram of queryTrigrams) if (candidate.has(gram)) overlap += 1;
  return overlap / queryTrigrams.size;
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(term, offset)) !== -1) {
    count += 1;
    offset += term.length;
  }
  return count;
}

function makeExcerpt(text, terms, maxChars = 520) {
  const normalized = normalizeText(text);
  let bestIndex = -1;
  for (const term of terms) {
    const index = normalized.indexOf(term);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) bestIndex = index;
  }
  if (bestIndex === -1) bestIndex = 0;
  const start = Math.max(0, bestIndex - 120);
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function truncateText(value, maximum) {
  const text = String(value ?? '').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trim()}…`;
}

function makeSectionExcerpt(section, terms) {
  if (!section.verifiedText && !section.unverifiedText) return makeExcerpt(section.text, terms);
  return [
    section.observedDate ? `記録日: ${section.observedDate}` : null,
    Number.isInteger(section.recordOrder) && Number.isInteger(section.recordCount)
      ? `同日内の記録順: ${section.recordOrder + 1}/${section.recordCount}（数字が大きいほど後）`
      : null,
    section.itemText ? `項目: ${truncateText(section.itemText, 70)}` : null,
    `確認できたこと: ${truncateText(section.verifiedText, 280)}`,
    `確認できていないこと: ${truncateText(section.unverifiedText, 130)}`,
  ].filter(Boolean).join('\n');
}

function prefersCurrentVerifiedState(query, timeScope) {
  return /これまで|今まで|今|現在|最新|現状|次|これから|進捗|どこまで|確かめ|確認|実機|current|latest|history/.test(
    normalizeText(`${query}\n${timeScope ?? ''}`),
  );
}

function prefersLatestLedgerEntry(query, timeScope) {
  return /今|現在|最新|今日|進捗|どこまで|次|これから|現状|もう/.test(
    normalizeText(`${query}\n${timeScope ?? ''}`),
  );
}

function verificationScore(text) {
  const normalized = normalizeText(text);
  const positive = /合格|確認済み|成功|完了|完走/.test(normalized);
  const negative = /未確認|未実施|未合格|失敗|タイムアウト/.test(normalized);
  if (positive === negative) return 0;
  return positive ? 1 : -1;
}

function needsPreviousLedgerContext(candidate) {
  if (!Number.isInteger(candidate.recordOrder) || candidate.recordOrder < 1) return false;
  const text = normalizeText(candidate.excerpt);
  return /上の|上記|同上|証拠.*保存|監査.*保存|v\d+\.\d+\.\d+保存|github.*保存/.test(text);
}

function timelineEndpointCandidate(candidates, query) {
  const normalizedQuery = normalizeText(query);
  if (!/実音声|音声.*成功/.test(normalizedQuery)) return null;
  return candidates
    .filter((candidate) =>
      Number.isInteger(candidate.recordOrder) &&
      !needsPreviousLedgerContext(candidate) &&
      /rokidマイク|利用者.{0,60}発話|人の声.{0,60}(合格|成功|完走)/.test(normalizeText(candidate.excerpt)),
    )
    .sort((left, right) => (right.recordOrder ?? -1) - (left.recordOrder ?? -1))[0] ?? null;
}

export async function searchVault(vaultPath, query, options = {}) {
  const scan = options.scan ?? (await scanVault(vaultPath, options));
  const terms = extractTerms(query, options.terms ?? []);
  const requiredTerms = (options.requiredTerms ?? []).map(normalizeText).filter(Boolean);
  const queryTrigrams = trigrams(query);
  const preferCurrentVerified = prefersCurrentVerifiedState(query, options.timeScope);
  const preferLatestLedger = !options.timeline && prefersLatestLedgerEntry(query, options.timeScope);
  const candidates = [];

  for (const document of scan.documents) {
    if (options.evidenceRoles?.length && !options.evidenceRoles.includes(document.evidenceRole)) {
      continue;
    }
    const normalizedPath = normalizeText(document.relativePath);
    const normalizedTitle = normalizeText(document.title);
    const normalizedDocument = normalizeText(`${document.relativePath}\n${document.title}\n${document.sections
      .map((section) => `${section.heading}\n${section.text}`)
      .join('\n')}`);
    if (requiredTerms.length && !requiredTerms.every((term) => normalizedDocument.includes(term))) {
      continue;
    }
    for (const section of document.sections) {
      const normalizedHeading = normalizeText(section.heading);
      const normalizedBody = normalizeText(section.text);
      const normalizedVerifiedBody = normalizeText(section.verifiedText || section.text);
      const normalizedItem = normalizeText(section.itemText ?? '');
      const sectionContent = `${normalizedHeading}\n${normalizedItem}\n${normalizedBody}`;
      const requiredTermsInSection = requiredTerms.every((term) => sectionContent.includes(term));
      if (
        requiredTerms.length && !requiredTermsInSection &&
        !terms.some((term) => sectionContent.includes(term))
      ) {
        continue;
      }
      let score = document.priority;
      if (preferLatestLedger && document.sourceKind === 'current_system_summary') {
        score += 160;
      }
      let matched = false;
      for (const term of terms) {
        if (normalizedPath.includes(term)) {
          score += 12;
          matched = true;
        }
        if (normalizedTitle.includes(term)) {
          score += 10;
          matched = true;
        }
        if (normalizedHeading.includes(term)) {
          score += 8;
          matched = true;
        }
        if (normalizedItem.includes(term)) {
          score += 6;
          matched = true;
        }
        const occurrences = countOccurrences(
          preferCurrentVerified ? normalizedVerifiedBody : normalizedBody,
          term,
        );
        if (occurrences) {
          score += Math.min(occurrences, 5) * 2;
          matched = true;
        }
      }
      const semanticHint = overlapScore(
        queryTrigrams,
        `${document.title}\n${section.heading}\n${section.itemText ?? ''}\n` +
          `${preferCurrentVerified ? section.verifiedText || section.text : section.text}`,
      );
      if (semanticHint >= 0.12) {
        score += semanticHint * 8;
        matched = true;
      }
      if (!matched || score <= 0) continue;
      const observedDate = section.observedDate ?? document.observedDate;
      const chronology = chronologyMetadata(observedDate, `${section.heading}\n${section.text}`);
      if (preferCurrentVerified) score += verificationScore(section.verifiedText || section.text) * 2;
      if (
        preferCurrentVerified && Number.isInteger(section.recordOrder) &&
        Number.isInteger(section.recordCount) && section.recordCount > 0
      ) {
        const chronologyRatio = (section.recordOrder + 1) / section.recordCount;
        score += chronologyRatio * (options.timeline ? 100 : 12);
        if (section.recordOrder === section.recordCount - 1) {
          score += preferLatestLedger ? 200 : 10;
        }
      }
      candidates.push({
        path: document.relativePath.split(path.sep).join('/'),
        title: document.title,
        section: section.heading,
        sourceKind: document.sourceKind,
        evidenceRole: document.evidenceRole,
        sendPolicy: document.sendPolicy,
        observedDate,
        ...chronology,
        recordOrder: section.recordOrder ?? null,
        recordCount: section.recordCount ?? null,
        score: Number(score.toFixed(3)),
        excerpt: makeSectionExcerpt(section, terms),
      });
    }
  }

  if (preferCurrentVerified) {
    const newestDateByPath = new Map();
    for (const candidate of candidates) {
      if (!candidate.observedDate) continue;
      const current = newestDateByPath.get(candidate.path) ?? '';
      if (candidate.observedDate > current) newestDateByPath.set(candidate.path, candidate.observedDate);
    }
    for (const candidate of candidates) {
      if (candidate.observedDate && candidate.observedDate === newestDateByPath.get(candidate.path)) {
        candidate.score = Number((candidate.score + 6).toFixed(3));
      }
    }
  }

  candidates.sort((left, right) =>
    right.score - left.score ||
    (preferCurrentVerified
      ? String(right.observedDate ?? '').localeCompare(String(left.observedDate ?? ''))
      : 0) ||
    (preferCurrentVerified ? (right.recordOrder ?? -1) - (left.recordOrder ?? -1) : 0) ||
    left.path.localeCompare(right.path, 'ja'));
  const limit = options.limit ?? 12;
  const perFileLimit = options.perFileLimit ?? 3;
  const ledgerRowsByPosition = new Map(
    candidates
      .filter((candidate) => Number.isInteger(candidate.recordOrder))
      .map((candidate) => [
        `${candidate.path}\u0000${candidate.observedDate ?? ''}\u0000${candidate.recordOrder}`,
        candidate,
      ]),
  );
  const pathCounts = new Map();
  const diverseCandidates = [];
  const timelineEndpoint = options.timeline ? timelineEndpointCandidate(candidates, query) : null;
  const currentSummaryAvailable = preferLatestLedger && candidates.some(
    (candidate) => candidate.sourceKind === 'current_system_summary',
  );
  if (timelineEndpoint) {
    diverseCandidates.push(timelineEndpoint);
    pathCounts.set(timelineEndpoint.path, 1);
  }
  for (const candidate of candidates) {
    if (candidate === timelineEndpoint) continue;
    if (options.timeline && needsPreviousLedgerContext(candidate)) continue;
    if (
      currentSummaryAvailable &&
      ['system_master', 'system_record'].includes(candidate.sourceKind)
    ) continue;
    const count = pathCounts.get(candidate.path) ?? 0;
    if (count >= perFileLimit) continue;
    let selectedCandidate = candidate;
    if (preferCurrentVerified && perFileLimit === 1 && needsPreviousLedgerContext(candidate)) {
      const previous = ledgerRowsByPosition.get(
        `${candidate.path}\u0000${candidate.observedDate ?? ''}\u0000${candidate.recordOrder - 1}`,
      );
      if (previous) {
        selectedCandidate = {
          ...candidate,
          excerpt: `直前の実体記録:\n${previous.excerpt}\n\n後続の保存・監査記録:\n${candidate.excerpt}`,
        };
      }
    }
    diverseCandidates.push(selectedCandidate);
    pathCounts.set(candidate.path, count + 1);
    if (diverseCandidates.length >= limit) break;
  }
  return {
    query,
    terms,
    requiredTerms,
    scannedDocuments: scan.documents.length,
    candidateCount: candidates.length,
    candidates: diverseCandidates,
  };
}

function parseArgs(argv) {
  const result = { terms: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--vault') result.vault = argv[++index];
    else if (argument === '--query') result.query = argv[++index];
    else if (argument === '--terms') result.terms = argv[++index].split(',').map((term) => term.trim());
    else if (argument === '--required') result.requiredTerms = argv[++index].split(',').map((term) => term.trim());
    else if (argument === '--limit') result.limit = Number(argv[++index]);
    else if (argument === '--roles') result.evidenceRoles = argv[++index].split(',').map((role) => role.trim());
    else if (argument === '--per-file') result.perFileLimit = Number(argv[++index]);
    else if (argument === '--policy') result.policyPath = argv[++index];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vault || !args.query) {
    console.error('Usage: node knowledge-router.mjs --vault <path> --query <text> [--terms a,b] [--limit 12]');
    process.exitCode = 2;
  } else {
    const result = await searchVault(args.vault, args.query, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
