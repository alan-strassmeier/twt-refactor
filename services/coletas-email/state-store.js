'use strict';

const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const path = require('node:path');

class StateStore {
  constructor(filename) {
    this.filename = filename;
    this.state = { cursor: null, delivered: {}, alerted: {}, attempts: {} };
  }

  async load() {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      const stored = JSON.parse(await readFile(this.filename, 'utf8'));
      this.state = { ...this.state, ...stored };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async save() {
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filename);
  }

  getCursor() {
    return this.state.cursor;
  }

  async setCursor(uid) {
    this.state.cursor = Number(uid);
    await this.save();
  }

  wasDelivered(key) {
    return Boolean(this.state.delivered[key]);
  }

  async markDelivered(key, details) {
    this.state.delivered[key] = { ...details, at: new Date().toISOString() };
    delete this.state.attempts[key];
    await this.save();
  }

  wasAlerted(key) {
    return Boolean(this.state.alerted[key]);
  }

  async markAlerted(key) {
    this.state.alerted[key] = new Date().toISOString();
    await this.save();
  }

  async registerFailure(key, error) {
    const current = this.state.attempts[key] || { count: 0 };
    this.state.attempts[key] = {
      count: current.count + 1,
      lastError: String(error?.message || error),
      at: new Date().toISOString()
    };
    await this.save();
    return this.state.attempts[key].count;
  }
}

module.exports = { StateStore };
