// Bounded across every tab. Queued jobs can be cancelled before making an API call.
(function (root) {
  function create(limit = 6) {
    let active = 0;
    const queue = [];
    const aborted = () => new DOMException('已取消翻译', 'AbortError');
    function pump() {
      while (active < limit && queue.length) {
        const item = queue.shift();
        item.signal?.removeEventListener('abort', item.cancel);
        if (item.signal?.aborted) { item.reject(aborted()); continue; }
        active += 1;
        Promise.resolve().then(() => {
          item.signal?.throwIfAborted();
          return item.task();
        }).then(item.resolve, item.reject).finally(() => { active -= 1; pump(); });
      }
    }
    return {
      run(task, signal) {
        if (signal?.aborted) return Promise.reject(aborted());
        return new Promise((resolve, reject) => {
          const item = { task, signal, resolve, reject };
          item.cancel = () => {
            const index = queue.indexOf(item);
            if (index >= 0) { queue.splice(index, 1); reject(aborted()); }
          };
          signal?.addEventListener('abort', item.cancel, { once: true });
          queue.push(item);
          pump();
        });
      }
    };
  }
  root.AdaptiveTranslationRequestScheduler = { create };
  if (typeof module === 'object') module.exports = { create };
})(globalThis);
