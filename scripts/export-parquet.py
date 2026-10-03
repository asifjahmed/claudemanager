#!/usr/bin/env python3
"""Export the claudemanager request log to Parquet, laid out for cleansing, labelling and training.

Reads the SQLite database read-only (safe while the daemon runs) and writes, under --out:

  requests/dt=YYYY-MM-DD/part-*.parquet
                                       one row per request: every requests column (metadata only), so
                                       requests whose bodies were pruned are still accounted for
  raw/dt=YYYY-MM-DD/part-*.parquet     (--raw only) one row per request, lossless: the metadata plus the
                                       system prompt, full messages, tools, params and response as JSON.
                                       Reconstructable from turns + blobs; 20-50x larger than turns
  turns/dt=YYYY-MM-DD/part-*.parquet   one row per (session, turn): only the turn's NEW user content and
                                       the assistant response, de-duplicated across the prefix that Claude
                                       Code re-sends on every request; system and tools by hash
  blobs/part-*.parquet                 unique system prompts and tool sets, keyed by sha256
  _schema/v1.json                      column documentation

Partitions are Hive-style and zstd-compressed, so DuckDB, Athena, Spark, pandas and Polars all read them
directly. Keys: raw.request_sha256 (content hash of the request) and turns.turn_id = sha256(session_id:turn)
are stable across machines; the database's integer ids are not. Label tables should key on turn_id.

Usage: export-parquet.py [--db PATH] [--out DIR] [--since ISO] [--until ISO] [--raw]
Requires pyarrow (pip install pyarrow). Re-running overwrites the partitions it touches.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError:
    sys.exit("pyarrow is required: pip install pyarrow")

RAW_SCHEMA = pa.schema(
    [
        ("request_sha256", pa.string()),
        ("db_id", pa.int64()),
        ("started_at", pa.timestamp("ms", tz="UTC")),
        ("finished_at", pa.timestamp("ms", tz="UTC")),
        ("latency_ms", pa.int64()),
        ("ttfb_ms", pa.int64()),
        ("overhead_ms", pa.int64()),
        ("account", pa.string()),
        ("account_uuid", pa.string()),
        ("model", pa.string()),
        ("model_fallback_from", pa.string()),
        ("path", pa.string()),
        ("session_id", pa.string()),
        ("stream", pa.bool_()),
        ("status_code", pa.int64()),
        ("error", pa.string()),
        ("switched_from", pa.string()),
        ("retried", pa.bool_()),
        ("rl_5h_util", pa.float64()),
        ("rl_5h_reset", pa.string()),
        ("rl_7d_util", pa.float64()),
        ("rl_7d_reset", pa.string()),
        ("rl_status", pa.string()),
        ("rl_claim", pa.string()),
        ("input_tokens", pa.int64()),
        ("output_tokens", pa.int64()),
        ("cache_read_tokens", pa.int64()),
        ("cache_write_tokens", pa.int64()),
        ("stop_reason", pa.string()),
        ("est_cost_usd", pa.float64()),
        ("body_mode", pa.string()),
        ("system_sha256", pa.string()),
        ("tools_sha256", pa.string()),
        ("system_json", pa.string()),
        ("messages_json", pa.string()),
        ("tools_json", pa.string()),
        ("params_json", pa.string()),
        ("response_json", pa.string()),
        ("response_error", pa.string()),
    ]
)

REQUEST_SCHEMA = pa.schema([f for f in RAW_SCHEMA if not f.name.endswith("_json") and f.name != "response_error"])

TURN_SCHEMA = pa.schema(
    [
        ("turn_id", pa.string()),
        ("session_id", pa.string()),
        ("turn_index", pa.int64()),
        ("request_sha256", pa.string()),
        ("started_at", pa.timestamp("ms", tz="UTC")),
        ("model", pa.string()),
        ("account", pa.string()),
        ("system_sha256", pa.string()),
        ("tools_sha256", pa.string()),
        ("params_json", pa.string()),
        ("user_messages_json", pa.string()),
        ("assistant_json", pa.string()),
        ("stop_reason", pa.string()),
        ("status_code", pa.int64()),
        ("input_tokens", pa.int64()),
        ("output_tokens", pa.int64()),
        ("cache_read_tokens", pa.int64()),
        ("cache_write_tokens", pa.int64()),
        ("est_cost_usd", pa.float64()),
        ("context_messages", pa.int64()),
        ("redaction_version", pa.int64()),
    ]
)

BLOB_SCHEMA = pa.schema([("sha256", pa.string()), ("kind", pa.string()), ("json", pa.string()), ("bytes", pa.int64())])


def gunzip_text(b) -> str | None:
    if b is None:
        return None
    try:
        return gzip.decompress(b).decode("utf-8")
    except Exception:
        return None


def sha(s: str | None) -> str | None:
    return hashlib.sha256(s.encode("utf-8")).hexdigest() if s is not None else None


def ms_to_dt(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc) if ms is not None else None


def last_turn(messages):
    """The messages from the last user message onward: the new content of this request."""
    if not isinstance(messages, list) or not messages:
        return messages
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], dict) and messages[i].get("role") == "user":
            return messages[i:]
    return messages[-1:]


class PartitionWriter:
    """One Parquet writer per partition directory, closed at the end."""

    def __init__(self, root: Path, schema: pa.Schema, batch_rows: int = 256):
        self.root, self.schema, self.batch_rows = root, schema, batch_rows
        self.writers: dict[str, pq.ParquetWriter] = {}
        self.buffers: dict[str, list[dict]] = defaultdict(list)
        self.counts: dict[str, int] = defaultdict(int)

    def add(self, part: str, row: dict):
        self.buffers[part].append(row)
        if len(self.buffers[part]) >= self.batch_rows:
            self.flush(part)

    def flush(self, part: str):
        rows = self.buffers.pop(part, [])
        if not rows:
            return
        if part not in self.writers:
            d = self.root / part
            d.mkdir(parents=True, exist_ok=True)
            self.writers[part] = pq.ParquetWriter(d / "part-0.parquet", self.schema, compression="zstd")
        table = pa.Table.from_pylist(rows, schema=self.schema)
        self.writers[part].write_table(table)
        self.counts[part] += len(rows)

    def close(self):
        for part in list(self.buffers):
            self.flush(part)
        for w in self.writers.values():
            w.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/.claudemanager/claudemanager.db"))
    ap.add_argument("--out", default=os.path.expanduser("~/.claudemanager/export"))
    ap.add_argument("--since", help="ISO date/time (UTC); only requests started at or after")
    ap.add_argument("--until", help="ISO date/time (UTC); only requests started before")
    ap.add_argument("--raw", action="store_true", help="also write the lossless raw/ layer (large)")
    args = ap.parse_args()

    out = Path(args.out)
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    where, params = [], []
    if args.since:
        where.append("r.started_at >= ?")
        params.append(int(datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc).timestamp() * 1000))
    if args.until:
        where.append("r.started_at < ?")
        params.append(int(datetime.fromisoformat(args.until).replace(tzinfo=timezone.utc).timestamp() * 1000))
    sql = f"""
      SELECT r.*, b.system, b.messages_gz, b.tools_gz, b.params, b.mode AS body_mode,
             p.content_gz, p.raw_error
      FROM requests r
      LEFT JOIN request_bodies b ON b.request_id = r.id
      LEFT JOIN responses p ON p.request_id = r.id
      {"WHERE " + " AND ".join(where) if where else ""}
      ORDER BY r.session_id, r.started_at, r.id
    """

    reqs = PartitionWriter(out / "requests", REQUEST_SCHEMA, batch_rows=1024)
    raw = PartitionWriter(out / "raw", RAW_SCHEMA, batch_rows=64) if args.raw else None
    turns = PartitionWriter(out / "turns", TURN_SCHEMA)
    blobs_seen: set[str] = set()
    blob_rows: list[dict] = []
    turn_index: dict[str, int] = defaultdict(int)
    n = 0

    for r in conn.execute(sql, params):
        n += 1
        started = ms_to_dt(r["started_at"])
        part = f"dt={started.strftime('%Y-%m-%d')}"
        system_json = r["system"]
        messages_json = gunzip_text(r["messages_gz"])
        tools_json = gunzip_text(r["tools_gz"])
        response_json = gunzip_text(r["content_gz"])
        system_sha, tools_sha = sha(system_json), sha(tools_json)
        for kind, h, js in (("system", system_sha, system_json), ("tools", tools_sha, tools_json)):
            if h and h not in blobs_seen:
                blobs_seen.add(h)
                blob_rows.append({"sha256": h, "kind": kind, "json": js, "bytes": len(js)})
        request_sha = sha(json.dumps([r["session_id"], r["started_at"], system_sha, tools_sha, messages_json, r["params"]]))

        row = {
                "request_sha256": request_sha,
                "db_id": r["id"],
                "started_at": started,
                "finished_at": ms_to_dt(r["finished_at"]),
                "latency_ms": r["latency_ms"],
                "ttfb_ms": r["ttfb_ms"],
                "overhead_ms": r["overhead_ms"],
                "account": r["account"],
                "account_uuid": r["account_uuid"],
                "model": r["model"],
                "model_fallback_from": r["model_fallback_from"],
                "path": r["path"],
                "session_id": r["session_id"],
                "stream": bool(r["stream"]),
                "status_code": r["status_code"],
                "error": r["error"],
                "switched_from": r["switched_from"],
                "retried": bool(r["retried"]),
                "rl_5h_util": r["rl_5h_util"],
                "rl_5h_reset": r["rl_5h_reset"],
                "rl_7d_util": r["rl_7d_util"],
                "rl_7d_reset": r["rl_7d_reset"],
                "rl_status": r["rl_status"],
                "rl_claim": r["rl_claim"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
                "cache_read_tokens": r["cache_read_tokens"],
                "cache_write_tokens": r["cache_write_tokens"],
                "stop_reason": r["stop_reason"],
                "est_cost_usd": r["est_cost_usd"],
                "body_mode": r["body_mode"],
                "system_sha256": system_sha,
                "tools_sha256": tools_sha,
                "system_json": system_json,
                "messages_json": messages_json,
                "tools_json": tools_json,
                "params_json": r["params"],
                "response_json": response_json,
                "response_error": r["raw_error"],
        }
        reqs.add(part, {f.name: row[f.name] for f in REQUEST_SCHEMA})
        if raw:
            raw.add(part, row)

        # turns: only requests with a recorded body and a session
        if messages_json is None or not r["session_id"]:
            continue
        try:
            messages = json.loads(messages_json)
        except Exception:
            continue
        new = last_turn(messages)
        idx = turn_index[r["session_id"]]
        turn_index[r["session_id"]] += 1
        turns.add(
            part,
            {
                "turn_id": sha(f"{r['session_id']}:{idx}"),
                "session_id": r["session_id"],
                "turn_index": idx,
                "request_sha256": request_sha,
                "started_at": started,
                "model": r["model"],
                "account": r["account"],
                "system_sha256": system_sha,
                "tools_sha256": tools_sha,
                "params_json": r["params"],
                "user_messages_json": json.dumps(new, ensure_ascii=False),
                "assistant_json": response_json,
                "stop_reason": r["stop_reason"],
                "status_code": r["status_code"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
                "cache_read_tokens": r["cache_read_tokens"],
                "cache_write_tokens": r["cache_write_tokens"],
                "est_cost_usd": r["est_cost_usd"],
                "context_messages": len(messages) if isinstance(messages, list) else None,
                "redaction_version": 0,
            },
        )
        if n % 5000 == 0:
            print(f"  {n} requests…", file=sys.stderr)

    reqs.close()
    if raw:
        raw.close()
    turns.close()
    (out / "blobs").mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(blob_rows, schema=BLOB_SCHEMA), out / "blobs" / "part-0.parquet", compression="zstd")
    (out / "_schema").mkdir(exist_ok=True)
    (out / "_schema" / "v1.json").write_text(
        json.dumps(
            {
                "version": 1,
                "exported_at": datetime.now(timezone.utc).isoformat(),
                "requests": {f.name: str(f.type) for f in REQUEST_SCHEMA},
                "raw": {f.name: str(f.type) for f in RAW_SCHEMA},
                "turns": {f.name: str(f.type) for f in TURN_SCHEMA},
                "blobs": {f.name: str(f.type) for f in BLOB_SCHEMA},
                "notes": {
                    "turn_id": "sha256('<session_id>:<turn_index>'); the key for label tables",
                    "user_messages_json": "messages from the last user message of the request onward (the new content of this turn); earlier turns of the session hold the rest",
                    "assistant_json": "the response content blocks (text, thinking, tool_use) for this turn",
                    "redaction_version": "0 = unredacted",
                },
            },
            indent=2,
        )
    )
    print(f"{n} requests → requests {sum(reqs.counts.values())} rows in {len(reqs.counts)} days, turns {sum(turns.counts.values())} rows, {len(blob_rows)} blobs{', raw ' + str(sum(raw.counts.values())) + ' rows' if raw else ''} → {out}")


if __name__ == "__main__":
    main()
