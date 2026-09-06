import fs from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import { atomicJson } from "./safety.mjs";

// Only one process may keep an in-memory copy of a workspace for writing.
export async function acquireWorkspaceInstance(directory) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "instance.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(
        file,
        JSON.stringify({ pid: process.pid, url: null }),
        { flag: "wx" },
      );
      const release = () => {
        try {
          unlinkSync(file);
        } catch {}
      };
      process.once("exit", release);
      return {
        existing: false,
        async publish(url) {
          await atomicJson(file, { pid: process.pid, url });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let instance;
      try {
        instance = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        throw new Error(
          "PerfectWorkの起動処理を確認できません。少し待ってから再度起動してください。",
        );
      }
      if (!Number.isSafeInteger(instance.pid) || instance.pid <= 0)
        throw new Error(
          "PerfectWorkの起動情報が不正です。instance.jsonを確認してください。",
        );
      let alive = true;
      try {
        process.kill(instance.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) return { existing: true, url: instance.url };
      // A crashed process leaves only this exact application-owned lock file.
      await fs.unlink(file);
    }
  }
  throw new Error("PerfectWorkを起動できませんでした。再度お試しください。");
}
