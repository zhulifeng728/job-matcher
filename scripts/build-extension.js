#!/usr/bin/env node
/**
 * build-extension.js —— 把 extension/ 打成可分发的 zip
 *
 * 零依赖：自己写 zip（store 模式，不压缩）。
 * 扩展总共 64K，不压缩也够小，省掉引入压缩库的麻烦。
 */

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'extension');
const OUT_DIR = resolve(ROOT, 'public/download');
const OUT = resolve(OUT_DIR, 'job-matcher-extension.zip');

/** 递归收集文件 */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ full, rel: relative(base, full).split('\\').join('/'), mtime: st.mtime });
  }
  return out;
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

const files = walk(SRC).sort((a, b) => a.rel.localeCompare(b.rel));
const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const data = readFileSync(f.full);
  const nameBuf = Buffer.from(f.rel, 'utf-8');
  const crc = crc32(data) >>> 0;
  const { time, date } = dosTime(f.mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);        // version needed
  local.writeUInt16LE(0x0800, 6);    // flags: UTF-8
  local.writeUInt16LE(0, 8);         // method: store
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const localEntry = Buffer.concat([local, nameBuf, data]);
  locals.push(localEntry);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);      // version made by
  central.writeUInt16LE(20, 6);      // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);      // extra
  central.writeUInt16LE(0, 32);      // comment
  central.writeUInt16LE(0, 34);      // disk
  central.writeUInt16LE(0, 36);      // internal attr
  central.writeUInt32LE(0, 38);      // external attr
  central.writeUInt32LE(offset, 42);

  centrals.push(Buffer.concat([central, nameBuf]));
  offset += localEntry.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, Buffer.concat([...locals, centralBuf, eocd]));

console.log(`✓ 扩展已打包：${OUT}`);
console.log(`  ${files.length} 个文件，${(statSync(OUT).size / 1024).toFixed(1)} KB`);
for (const f of files) console.log(`    ${f.rel}`);
