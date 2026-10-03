import { EventEmitter } from "node:events";
import type { CmEvent } from "./types.js";

export class EventBus extends EventEmitter {
  private ring: CmEvent[] = [];
  constructor(private readonly capacity = 500) {
    super();
    this.setMaxListeners(100);
  }
  publish(ev: CmEvent): void {
    // requests are in the database; usage/state are high-frequency noise: neither belongs in the event log
    if (ev.type !== "usage" && ev.type !== "state" && ev.type !== "request") {
      this.ring.push(ev);
      if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    }
    this.emit("event", ev);
  }
  recent(limit = 100): CmEvent[] {
    return this.ring.slice(-limit);
  }
  subscribe(fn: (ev: CmEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}
