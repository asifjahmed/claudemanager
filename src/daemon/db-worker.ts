/** Worker thread that owns the write connection: parsing, compression, SQLite writes and pruning happen here. */
import { parentPort, workerData } from "node:worker_threads";
import { Db } from "../core/db.js";
import { applyWrite, type WriteMsg } from "./record-ops.js";

const db = new Db(workerData.path as string);
const lastUserText = new Map<number, string | null>();
let applied = 0;
let ackTimer: NodeJS.Timeout | null = null;
parentPort!.on("message", (msg: WriteMsg) => {
  try {
    const reply = applyWrite(db, msg, lastUserText);
    if (reply) parentPort!.postMessage(reply);
  } catch (err: any) {
    parentPort!.postMessage({ op: "error", message: `${msg.op}: ${err?.message ?? err}` });
  } finally {
    applied++;
    // coalesced progress ack so the main thread can measure backlog without one reply per message
    if (!ackTimer) {
      ackTimer = setTimeout(() => {
        ackTimer = null;
        parentPort!.postMessage({ op: "applied", n: applied });
      }, 50);
    }
    if (msg.op === "finish") lastUserText.delete(msg.id); // a failed finish must not leak its start entry
  }
});
parentPort!.postMessage({ op: "ready", maxRequestId: db.maxRequestId() });
