import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAdbDevices,
  parseAdbMdnsServices,
  parseBonjourBrowse,
  parseBonjourLookup,
  resolveRokidDevice,
} from './adb-device-resolver.mjs';

test('ADBとBonjourの表示から現在の暗号化接続先だけを読む', () => {
  assert.deepEqual(parseAdbDevices([
    'List of devices attached',
    'Android.local.:34383 device product:glasses model:RG_glasses',
    'bad offline',
  ].join('\n')), ['Android.local.:34383']);
  assert.deepEqual(parseAdbMdnsServices([
    'List of discovered mdns services',
    'adb-id _adb-tls-connect._tcp 192.168.11.46:34383',
    'pair _adb-tls-pairing._tcp 192.168.11.46:40000',
  ].join('\n')), ['192.168.11.46:34383']);
  assert.deepEqual(parseBonjourBrowse(
    '17:00:00.000  Add 2 14 local. _adb-tls-connect._tcp. adb-1904092623382143-zUcqKt\n',
  ), ['adb-1904092623382143-zUcqKt']);
  assert.equal(
    parseBonjourLookup('adb-x can be reached at Android.local.:34383 (interface 14)'),
    'Android.local.:34383',
  );
});

test('接続済み候補はRG-glasses確認後だけ採用する', async () => {
  const calls = [];
  const runAdb = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'devices') {
      return { stdout: 'List of devices attached\nAndroid.local.:34383 device product:glasses\n' };
    }
    if (args.includes('getprop')) return { stdout: 'RG-glasses\n' };
    return { stdout: '' };
  };
  const result = await resolveRokidDevice({
    adbPath: '/test/adb',
    port: 5042,
    runAdb,
    browseBonjour: async () => { throw new Error('must not browse'); },
  });
  assert.equal(result.serial, 'Android.local.:34383');
  assert.equal(result.discovery, 'connected');
  assert.deepEqual(calls, [
    'start-server',
    'devices -l',
    '-s Android.local.:34383 shell getprop ro.product.model',
  ]);
});

test('ADB mDNSが空ならBonjourで現行TLSポートへ接続する', async () => {
  let deviceChecks = 0;
  const calls = [];
  const runAdb = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'devices') {
      deviceChecks += 1;
      return {
        stdout: deviceChecks === 1
          ? 'List of devices attached\n'
          : 'List of devices attached\nAndroid.local.:45678 device product:glasses\n',
      };
    }
    if (args[0] === 'mdns') return { stdout: 'List of discovered mdns services\n' };
    if (args.includes('getprop')) return { stdout: 'RG_glasses\n' };
    return { stdout: '' };
  };
  const result = await resolveRokidDevice({
    adbPath: '/test/adb',
    port: 5042,
    runAdb,
    browseBonjour: async () => ['Android.local.:45678'],
  });
  assert.equal(result.discovery, 'bonjour');
  assert.match(calls.join('\n'), /^connect Android\.local\.:45678$/m);
});

test('別端末だけならRokidとして採用しない', async () => {
  const runAdb = async (args) => {
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nphone:1 device\n' };
    if (args.includes('getprop')) return { stdout: 'motorola edge 60\n' };
    if (args[0] === 'mdns') return { stdout: '' };
    return { stdout: '' };
  };
  await assert.rejects(resolveRokidDevice({
    adbPath: '/test/adb',
    runAdb,
    browseBonjour: async () => [],
  }), /not reachable/);
});
