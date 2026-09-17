'use strict';
// node test-due.js — 驗證 computeDue 的時間窗與去重
const assert = require('assert');
const { computeDue } = require('./due');

// 台北時間 2026-09-18 20:00 = UTC 12:00
const at = (hh, mm) => new Date(Date.UTC(2026, 8, 18, hh - 8, mm));
const dates = { '2026-09-18': { slots: [{ start: '20:00', end: '22:00' }, { start: '23:30', end: '23:59' }, { start: '', end: '' }] } };

let r = computeDue(dates, at(20, 0), {}, '恩恩');
assert.deepStrictEqual(r.map(x => x.key), ['2026-09-18_0_start'], '開播當下要提醒');
assert.ok(r[0].title.includes('恩恩') && r[0].body.includes('20:00'), '標題含暱稱、內文含時間');

r = computeDue(dates, at(20, 4), {}, '');
assert.deepStrictEqual(r.map(x => x.key), ['2026-09-18_0_start'], '開播後 4 分仍在窗內');

r = computeDue(dates, at(20, 6), {}, '');
assert.deepStrictEqual(r, [], '開播後 6 分不補彈');

r = computeDue(dates, at(19, 59), {}, '');
assert.deepStrictEqual(r.map(x => x.key), ['2026-09-18_0_start'], '排程早 1 分鐘也能命中');

r = computeDue(dates, at(20, 0), { '2026-09-18_0_start': '2026-09-18T11:59:00Z' }, '');
assert.deepStrictEqual(r, [], '已發送過不再重複');

r = computeDue(dates, at(21, 55), {}, '');
assert.deepStrictEqual(r.map(x => x.key), ['2026-09-18_0_end'], '下播前 5 分提醒');

r = computeDue(dates, at(22, 0), {}, '');
assert.deepStrictEqual(r, [], '下播時間到就不再提醒');

r = computeDue(dates, at(23, 30), {}, '');
assert.deepStrictEqual(r.map(x => x.key), ['2026-09-18_1_start'], '第二場開播');

r = computeDue(dates, at(23, 55), {}, '');
assert.deepStrictEqual(r.map(x => x.key), ['2026-09-18_1_end'], '第二場下播前');

r = computeDue({}, at(20, 0), {}, '');
assert.deepStrictEqual(r, [], '沒有資料');

r = computeDue({ '2026-09-18': { slots: 'bad' } }, at(20, 0), {}, '');
assert.deepStrictEqual(r, [], '壞資料不炸');

// 跨日：台北 00:03 = 前一天 UTC 16:03，日曆日應是新的一天
const dates2 = { '2026-09-19': { slots: [{ start: '00:00', end: '01:00' }] } };
r = computeDue(dates2, new Date(Date.UTC(2026, 8, 18, 16, 3)), {}, '');
assert.deepStrictEqual(r.map(x => x.key), ['2026-09-19_0_start'], '台北凌晨用台北日期');

console.log('computeDue: all tests passed');
