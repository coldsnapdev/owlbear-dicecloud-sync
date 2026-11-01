// Writing HP to DiceCloud sheets.
//
// DiceCloud has no REST endpoint for changing a sheet; its own web app talks to the
// server over Meteor's DDP protocol (a WebSocket). We call the same method the sheet
// calls when a player types damage into their HP bar (see damageAttribute), so their
// on-damage triggers run and their HP bar updates live. The account needs edit (not
// just read) access to the sheet.

const DDP_URL = "wss://dicecloud.com/websocket";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Ddp {
  private ws?: WebSocket;
  private ready?: Promise<void>;
  private loggedInWith?: string;
  private id = 0;
  private pending = new Map<string, Pending>();

  private open(): Promise<void> {
    if (this.ready && this.ws && this.ws.readyState <= 1) return this.ready;
    this.loggedInWith = undefined;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(DDP_URL);
      this.ws = ws;
      const fail = (why: string) => {
        reject(new Error(why));
        for (const p of this.pending.values()) p.reject(new Error(why));
        this.pending.clear();
        this.ready = undefined;
      };
      const timer = setTimeout(() => {
        ws.close();
        fail("DiceCloud didn't answer");
      }, 8000);
      ws.onopen = () => ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1", "pre2", "pre1"] }));
      ws.onerror = () => fail("couldn't reach DiceCloud");
      ws.onclose = () => fail("DiceCloud connection closed");
      ws.onmessage = (e) => {
        let m: any;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.msg === "connected") {
          clearTimeout(timer);
          resolve();
        } else if (m.msg === "ping") ws.send(JSON.stringify({ msg: "pong", id: m.id }));
        else if (m.msg === "failed") fail("DiceCloud refused the connection");
        else if (m.msg === "result") {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.reason || m.error.message || m.error.error || "DiceCloud error"));
          else p.resolve(m.result);
        }
      };
    });
    return this.ready;
  }

  async call(method: string, ...params: unknown[]): Promise<any> {
    await this.open();
    const id = String(++this.id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ msg: "method", id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`DiceCloud took too long (${method})`));
      }, 10000);
    });
  }

  async login(token: string) {
    await this.open();
    if (this.loggedInWith === token) return;
    await this.call("login", { resume: token });
    this.loggedInWith = token;
  }
}

const ddp = new Ddp();

/**
 * Change one attribute the way the sheet does: increment (damage; negative heals) or set.
 *
 * The released DiceCloud (master branch, what dicecloud.com runs) has one method for this,
 * "creatureProperties.damage" (app/imports/api/creature/creatureProperties/methods/
 * damageProperty.js): it checks edit permission, runs the sheet's on-damage triggers and
 * writes a log entry, exactly as typing into the HP bar does. DiceCloud's development
 * branch replaces it with an "actions" engine; if the site ever moves to that, we fall
 * back to it automatically.
 */
export async function damageAttribute(token: string, creatureId: string, prop: any, operation: "increment" | "set", value: number): Promise<void> {
  await ddp.login(token);
  try {
    await ddp.call("creatureProperties.damage", { _id: prop._id, operation, value });
    return;
  } catch (err) {
    if (!/not found/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  const actionId = await ddp.call("actions.insertAction", {
    action: {
      creatureId,
      task: {
        subtaskFn: "damageProp",
        targetIds: [creatureId],
        params: { title: prop.name || "Hit Points", operation, value, targetProp: prop },
      },
      results: [],
      taskCount: 0,
    },
  });
  await ddp.call("actions.runAction", { actionId, decisions: [] });
}
