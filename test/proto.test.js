import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeFields, encodeFields, encodeVarint, fieldBytes, fieldString, fieldVarint,
  getFloat, getInt, getMessage, getMessages, readVarint, unwrapTransport,
} from '../lib/proto.js';

test('varints round-trip, including multi-byte and large values', () => {
  for (const n of [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 40]) {
    const [value, pos] = readVarint(encodeVarint(n), 0);
    assert.equal(value, n);
    assert.equal(pos, encodeVarint(n).length);
  }
});

test('a truncated varint is rejected', () => {
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), /varint/);
});

test('decodeFields and encodeFields are inverses', () => {
  const buf = Buffer.concat([fieldVarint(1, 150), fieldString(2, 'hello'), fieldVarint(3, 0)]);
  const fields = decodeFields(buf);
  assert.equal(fields.length, 3);
  assert.equal(getInt(fields, 1), 150);
  assert.equal(getMessage(fields, 2).toString(), 'hello');
  assert.deepEqual(encodeFields(fields), buf);
});

test('getters pick the last value and honour the fallback', () => {
  const fields = decodeFields(Buffer.concat([fieldVarint(1, 1), fieldVarint(1, 2)]));
  assert.equal(getInt(fields, 1), 2);
  assert.equal(getInt(fields, 9), undefined);
  assert.equal(getInt(fields, 9, 7), 7);
  assert.equal(getMessage(fields, 1), undefined);
});

test('getMessages returns every length-delimited field of a number', () => {
  const fields = decodeFields(Buffer.concat([fieldString(4, 'a'), fieldString(4, 'b'), fieldVarint(5, 1)]));
  assert.deepEqual(getMessages(fields, 4).map(String), ['a', 'b']);
});

test('getFloat reads a 32-bit little-endian float', () => {
  const f = Buffer.alloc(4);
  f.writeFloatLE(83.5);
  const fields = decodeFields(Buffer.concat([Buffer.from([(2 << 3) | 5]), f]));
  assert.equal(getFloat(fields, 2), 83.5);
});

test('malformed protobuf is rejected', () => {
  assert.throws(() => decodeFields(Buffer.from([0x00, 0x01])), /field number/);
  assert.throws(() => decodeFields(Buffer.from([(1 << 3) | 2, 5, 1])), /Truncated/);
  assert.throws(() => decodeFields(Buffer.from([(1 << 3) | 3])), /wire type/);
});

test('unwrapTransport splits the header from the body', () => {
  const header = Buffer.from('HDR');
  const body = Buffer.from('BODYBYTES');
  const framed = Buffer.concat([Buffer.from([1]), encodeVarint(header.length), header, body]);
  const out = unwrapTransport(framed);
  assert.equal(out.header.toString(), 'HDR');
  assert.equal(out.body.toString(), 'BODYBYTES');
});

test('unwrapTransport rejects a bad marker and a truncated header', () => {
  assert.throws(() => unwrapTransport(Buffer.from([2, 0])), /marker/);
  assert.throws(() => unwrapTransport(Buffer.from([])), /marker/);
  assert.throws(() => unwrapTransport(Buffer.from([1, 10, 65])), /Truncated/);
});

test('fieldBytes encodes tag, length and payload', () => {
  assert.deepEqual([...fieldBytes(1, Buffer.from([9, 9]))], [(1 << 3) | 2, 2, 9, 9]);
});
