import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function createBaseAix(parentDirectory) {
  const source = path.join(parentDirectory, 'base-source');
  const output = path.join(parentDirectory, 'base.aix');
  await mkdir(path.join(source, 'pages/index'), { recursive: true });
  const page = await readFile(path.join(import.meta.dirname, 'templates/index-base.ink'), 'utf8');
  await Promise.all([
    writeFile(path.join(source, 'VERSION'), 'test-fixture-version\n'),
    writeFile(path.join(source, 'AGENTS.md'), '# Test fixture\n'),
    writeFile(path.join(source, 'README.md'), 'Test fixture only.\n'),
    writeFile(path.join(source, 'app.js'), 'export default {}\n'),
    writeFile(path.join(source, 'app.json'), JSON.stringify({ pages: ['pages/index/index'] }, null, 2)),
    writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'rokid-aiui-text-bridge-fixture',
      version: '0.0.0-test',
      private: true,
    }, null, 2)),
    writeFile(path.join(source, 'pages/index/index.ink'), page),
  ]);
  execFileSync('/usr/bin/zip', ['-q', '-r', output, '.'], { cwd: source });
  return output;
}
