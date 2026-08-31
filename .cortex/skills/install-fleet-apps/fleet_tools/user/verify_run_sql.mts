// Throwaway harness: exercise run_sql's validate guards without Snowflake.
// Run with: npx tsx ../../verify_run_sql.mts   (from fleet_tools/user)
import { run_sql } from './src/procs/run_sql.js';

type Case = { sql: string; expect: string | null; why: string };

const cases: Case[] = [
  { sql: 'SELECT 1', expect: null, why: 'plain select' },
  { sql: '  select * from t  ', expect: null, why: 'lowercase + whitespace' },
  { sql: 'WITH a AS (SELECT 1) SELECT * FROM a', expect: null, why: 'CTE' },
  { sql: 'SHOW SERVICES IN ACCOUNT', expect: null, why: 'SHOW' },
  { sql: 'DESCRIBE TABLE t', expect: null, why: 'DESCRIBE' },
  { sql: 'EXPLAIN SELECT 1', expect: null, why: 'EXPLAIN' },
  { sql: 'SELECT 1;', expect: null, why: 'trailing semicolon is fine' },
  { sql: '-- note\nSELECT 1', expect: null, why: 'line comment then select' },
  { sql: "SELECT 'a;b' AS x", expect: null, why: 'semicolon inside a literal is not a separator' },

  { sql: 'DROP TABLE t', expect: 'SQL_NOT_READ_ONLY', why: 'drop' },
  { sql: 'delete from t', expect: 'SQL_NOT_READ_ONLY', why: 'delete' },
  { sql: 'INSERT INTO t VALUES (1)', expect: 'SQL_NOT_READ_ONLY', why: 'insert' },
  { sql: 'MERGE INTO t USING s ON 1=1', expect: 'SQL_NOT_READ_ONLY', why: 'merge' },
  { sql: 'CALL some_proc()', expect: 'SQL_NOT_READ_ONLY', why: 'call' },
  { sql: 'GRANT SELECT ON t TO ROLE r', expect: 'SQL_NOT_READ_ONLY', why: 'grant' },
  { sql: 'CREATE TABLE t (a INT)', expect: 'SQL_NOT_READ_ONLY', why: 'create' },
  { sql: 'ALTER SESSION SET x = 1', expect: 'SQL_NOT_READ_ONLY', why: 'alter' },

  { sql: '/* c */ DROP TABLE t', expect: 'SQL_NOT_READ_ONLY', why: 'block comment cannot mask a drop' },
  { sql: '--x\n/*y*/ TRUNCATE TABLE t', expect: 'SQL_NOT_READ_ONLY', why: 'mixed comments cannot mask' },
  { sql: 'SELECT 1; DROP TABLE t', expect: 'SQL_MULTI_STATEMENT', why: 'piggybacked statement' },
  { sql: 'SELECT 1; SELECT 2', expect: 'SQL_MULTI_STATEMENT', why: 'two selects still rejected' },
  { sql: '   ', expect: 'SQL_EMPTY', why: 'whitespace only' },
  { sql: '-- only a comment', expect: 'SQL_EMPTY', why: 'comment only' },
];

let failures = 0;

for (const c of cases) {
  let code: string | null = null;
  const ctx = {
    fail: (k: string, m: string) => {
      if (code === null) code = k;
      throw new Error(`__fail__:${k}:${m}`);
    },
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (run_sql as any).validate({ sql: c.sql, max_rows: null }, ctx);
  } catch (e) {
    if (!String((e as Error).message).startsWith('__fail__:')) throw e;
  }
  const ok = code === c.expect;
  if (!ok) failures += 1;
  const shown = JSON.stringify(c.sql).slice(0, 46);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${shown.padEnd(48)} expected=${String(c.expect)} got=${String(code)}  (${c.why})`);
}

// max_rows guard
for (const [v, expect] of [[0, 'INVALID_MAX_ROWS'], [-5, 'INVALID_MAX_ROWS'], [1.5, 'INVALID_MAX_ROWS'], [50, null]] as const) {
  let code: string | null = null;
  const ctx = { fail: (k: string) => { if (code === null) code = k; throw new Error('__fail__:' + k); } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (run_sql as any).validate({ sql: 'SELECT 1', max_rows: v }, ctx);
  } catch (e) {
    if (!String((e as Error).message).startsWith('__fail__:')) throw e;
  }
  const ok = code === expect;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  max_rows=${v} expected=${String(expect)} got=${String(code)}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
