"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One read at a time. A failed refresh never erases the last known facts. */
export function useLiveRecord<T>(read: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let pending = false;
    setData(null);
    setError("");
    setUpdatedAt(null);
    const refresh = async () => {
      if (pending || !active) return;
      pending = true;
      setRefreshing(true);
      try {
        const value = await read();
        if (active) {
          setData(value);
          setUpdatedAt(new Date());
          setError("");
        }
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : "读取失败");
      } finally {
        pending = false;
        if (active) setRefreshing(false);
      }
    };
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    reload.current = () => void refresh();
    void refresh();
    const timer = window.setInterval(visibleRefresh, 15000);
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [read]);
  const refresh = useCallback(() => reload.current(), []);
  return { data, error, updatedAt, refreshing, refresh };
}
