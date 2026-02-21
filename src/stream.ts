import { Response } from "express";

type Client = {
  res: Response;
  types: Set<string>;
};

let clients: Client[] = [];

export function addClient(res: Response, types: string[]) {
  clients.push({ res, types: new Set(types) });
}

export function removeClient(res: Response) {
  clients = clients.filter((c) => c.res !== res);
}

export function broadcast(payload: any) {
  const type = (payload?.type ?? "").toString();
  const msg = `data: ${JSON.stringify(payload)}\n\n`;

  const alive: Client[] = [];

  for (const c of clients) {
    try {
      if (c.types.size === 0 || c.types.has(type)) {
        c.res.write(msg);
      }
      alive.push(c);
    } catch {
      // client morto -> non lo teniamo
      try { c.res.end(); } catch {}
    }
  }

  clients = alive;
}

export function clientsCount() {
  return clients.length;
}