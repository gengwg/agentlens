import { copyFileSync, existsSync } from "node:fs";
import { db } from "./db.js";
import { maskText, redactSecrets } from "./redact-secrets.js";

// Masking guards writes, so anything stored before it existed is still in the
// clear: event bodies from before v0.10.0, session titles and turn errors from
// before v0.12.4. This walks the store once and masks what is left.
//
// Safe to run over everything, repeatedly: masking is idempotent. A mask
// literal contains no pattern, so an already-masked row comes back byte for
// byte, and every mask is plain ASCII, so rewriting a serialized event cannot
// break its JSON.
//
//   agentlens redact-history            what would change
//   agentlens redact-history --apply    change it, after copying the database

type Change = { events: number; titles: number; errors: number };

export function scan(): Change {
  const counts: Change = { events: 0, titles: 0, errors: 0 };
  for (const { raw } of db.prepare(`SELECT raw FROM events`).iterate() as Iterable<{ raw: string }>)
    if (redactSecrets(raw) !== raw) counts.events++;
  for (const { title } of db.prepare(`SELECT title FROM sessions WHERE title IS NOT NULL`).iterate() as Iterable<{ title: string }>)
    if (maskText(title) !== title) counts.titles++;
  for (const { error } of db.prepare(`SELECT error FROM turns WHERE error IS NOT NULL`).iterate() as Iterable<{ error: string }>)
    if (maskText(error) !== error) counts.errors++;
  return counts;
}

export function apply(): Change {
  const counts: Change = { events: 0, titles: 0, errors: 0 };
  // seq is left alone on purpose: a shipper has already sent these events with
  // their content stripped, so there is nothing for the shared server to catch
  // up on, and bumping it would resend tens of thousands of rows for nothing.
  const setRaw = db.prepare(`UPDATE events SET raw = ? WHERE id = ?`);
  const setTitle = db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`);
  const setError = db.prepare(`UPDATE turns SET error = ? WHERE id = ?`);

  db.transaction(() => {
    for (const { id, raw } of db.prepare(`SELECT id, raw FROM events`).all() as { id: string; raw: string }[]) {
      const masked = redactSecrets(raw);
      if (masked !== raw) (setRaw.run(masked, id), counts.events++);
    }
    for (const { id, title } of db.prepare(`SELECT id, title FROM sessions WHERE title IS NOT NULL`).all() as { id: string; title: string }[]) {
      const masked = maskText(title);
      if (masked !== title) (setTitle.run(masked, id), counts.titles++);
    }
    for (const { id, error } of db.prepare(`SELECT id, error FROM turns WHERE error IS NOT NULL`).all() as { id: string; error: string }[]) {
      const masked = maskText(error);
      if (masked !== error) (setError.run(masked, id), counts.errors++);
    }
  })();
  return counts;
}

const describe = (c: Change) => `${c.events} events, ${c.titles} titles, ${c.errors} turn errors`;

export function backfillMain(argv: string[]) {
  const path = process.env.AGENTLENS_DB ?? "agentlens.db";
  if (!argv.includes("--apply")) {
    const found = scan();
    console.log(`${path}: ${describe(found)} hold something the masker would remove`);
    console.log(found.events + found.titles + found.errors ? "run again with --apply to mask them" : "nothing to do");
    return;
  }
  // The store is the only copy of this history; keep one before rewriting it.
  // Named to match the *.db-* ignore rule: this file is the whole store.
  const backup = `${path}-bak-before-redact`;
  if (path !== ":memory:" && existsSync(path) && !existsSync(backup)) {
    copyFileSync(path, backup);
    console.log(`copied ${path} to ${backup}`);
  }
  console.log(`masked ${describe(apply())}`);
}
