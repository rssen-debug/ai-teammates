import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Local durable delivery of independently verified learning, never tool replay.
export class LearningOutbox {
  constructor(dir, learning) {
    this.dir = dir;
    this.learning = learning;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  stage(payload) {
    if (!payload.goalId || !payload.receipts?.length || payload.receipts.some(r => r.verified !== true)) {
      throw new Error('Learning delivery requires verified receipts');
    }
    const file = path.join(this.dir, createHash('sha256').update(payload.goalId).digest('hex') + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  async drain() {
    if (this.running) return this.running;
    this.running = this.#deliver().finally(() => { this.running = null; });
    return this.running;
  }
  async #deliver() {
    const results = [];
    for (const name of fs.readdirSync(this.dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const file = path.join(this.dir, name);
      try {
        const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
        const result = await this.learning.learnFromVerifiedGoal(payload);
        fs.unlinkSync(file);
        results.push({ goalId: payload.goalId, ...result });
      } catch {
        // Preserve the payload for the next host start or completed run.
        results.push({ pending: true });
      }
    }
    return results;
  }
}
