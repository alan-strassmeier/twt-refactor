const createFixedWindowLimiter = ({ maximum, durationMs }) => {
  const store = new Map();

  const consume = (key, now = Date.now()) => {
    const current = store.get(key);
    if (!current || current.expiresAt <= now) {
      store.set(key, { count: 1, expiresAt: now + durationMs });
      return true;
    }
    current.count += 1;
    return current.count <= maximum;
  };

  const clear = (key) => store.delete(key);
  const reset = () => store.clear();

  return { consume, clear, reset };
};

module.exports = { createFixedWindowLimiter };
