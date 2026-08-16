/**
 * Shares an in-flight/successful async resource while allowing a later caller
 * to retry after initialization rejects.
 */
export const createRetryableAsyncSingleton = <Value>(
  load: () => Promise<Value>,
) => {
  let shared: Promise<Value> | null = null;
  return () => {
    if (shared) return shared;
    const attempt = Promise.resolve().then(load);
    const guarded = attempt.catch((error) => {
      if (shared === guarded) shared = null;
      throw error;
    });
    shared = guarded;
    return guarded;
  };
};
