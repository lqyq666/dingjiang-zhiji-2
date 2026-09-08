"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  canVisitWorkspace,
  roleHome,
  type SessionRole,
} from "../lib/session-policy";
import { requestWithTimeout } from "../lib/request-with-timeout";
import styles from "./session-gate.module.css";

type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: SessionRole;
};
type Session = {
  mode: "demo" | "production";
  companyName: string;
  user: SessionUser | null;
};
type SessionContextValue = Session & { logout: () => Promise<void> };
const SessionContext = createContext<SessionContextValue>({
  mode: "demo",
  companyName: "演示企业",
  user: null,
  logout: async () => {},
});
export const useEmployeeSession = () => useContext(SessionContext);

async function responseMessage(response: Response): Promise<string> {
  const data = (await response.json().catch(() => null)) as {
    message?: unknown;
  } | null;
  return typeof data?.message === "string"
    ? data.message
    : `请求失败（${response.status}）`;
}
function validSession(data: unknown): data is Session {
  if (!data || typeof data !== "object") return false;
  const s = data as Partial<Session>;
  return (
    typeof s.companyName === "string" &&
    ((s.mode === "demo" && s.user === null) ||
      (s.mode === "production" &&
        !!s.user &&
        typeof s.user.id === "string" &&
        typeof s.user.username === "string" &&
        typeof s.user.displayName === "string" &&
        ["PMC", "OWNER", "EXPERT_REVIEWER"].includes(s.user.role)))
  );
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ready" | "anonymous" | "error"
  >("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const path = usePathname();
  const router = useRouter();

  const clearSession = useCallback((broadcast = false) => {
    generation.current += 1;
    setSession(null);
    setError("");
    setStatus("anonymous");
    if (broadcast) channel.current?.postMessage("session-ended");
  }, []);
  const check = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await requestWithTimeout<Session | null>(
        "/api/auth/session",
        { cache: "no-store" },
        async (response) => {
          if (response.status === 401) return null;
          if (!response.ok) throw new Error(await responseMessage(response));
          const data: unknown = await response.json();
          if (!validSession(data))
            throw new Error("登录服务响应格式异常，请联系管理员");
          return data;
        },
        12_000,
      );
      if (current !== generation.current) return;
      setSession(next);
      setError("");
      setStatus(next ? "ready" : "anonymous");
    } catch (reason) {
      if (current !== generation.current) return;
      // Fail closed on an unknown session state; do not expose a prior employee's records.
      setSession(null);
      setError(reason instanceof Error ? reason.message : "无法验证登录状态");
      setStatus("error");
    }
  }, []);
  useEffect(() => {
    void check();
    const expired = () => clearSession(true);
    const visible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("dingjiang:session-expired", expired);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(visible, 60_000);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("dingjiang-session");
      channel.current.onmessage = (event) => {
        if (event.data === "session-ended") clearSession();
      };
    }
    return () => {
      generation.current += 1;
      clearInterval(timer);
      window.removeEventListener("dingjiang:session-expired", expired);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
      channel.current?.close();
      channel.current = null;
    };
  }, [check, clearSession]);

  const allowed = !session?.user || canVisitWorkspace(path, session.user.role);
  useEffect(() => {
    if (status === "ready" && session?.user && !allowed)
      router.replace(roleHome(session.user.role));
  }, [allowed, router, session, status]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    try {
      await requestWithTimeout(
        "/api/auth/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: fields.get("username"),
            password: fields.get("password"),
          }),
        },
        async (response) => {
          if (!response.ok) throw new Error(await responseMessage(response));
        },
      );
      form.reset();
      await check();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    // Remove records immediately, even when the network fails during sign-out.
    generation.current += 1;
    setSession(null);
    setStatus("loading");
    try {
      await requestWithTimeout(
        "/api/auth/logout",
        { method: "POST" },
        async (response) => {
          if (!response.ok && response.status !== 401)
            throw new Error(await responseMessage(response));
        },
        12_000,
      );
      clearSession(true);
      router.refresh();
    } catch {
      setError(
        "尚未确认服务器退出成功。请恢复连接后重试退出；不要将此浏览器交给其他员工。",
      );
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  if (status === "ready" && session && allowed)
    return (
      <SessionContext.Provider value={{ ...session, logout }}>
        <div key={`${session.mode}:${session.user?.id ?? "demo"}`}>
          {children}
        </div>
      </SessionContext.Provider>
    );
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="session-title">
        <p className={styles.eyebrow}>鼎江智绩 · 企业内部工作台</p>
        <h1 id="session-title">
          {status === "loading" || (status === "ready" && !allowed)
            ? "正在验证访问权限"
            : "员工账号登录"}
        </h1>
        <p className={styles.hint}>
          账号由本企业管理员分配。网页用于查看记录，业务执行在 WorkBuddy
          中完成。
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {status === "anonymous" && (
          <form onSubmit={(event) => void login(event)} className={styles.form}>
            <label htmlFor="username">员工账号</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              maxLength={80}
              required
              disabled={busy}
            />
            <label htmlFor="password">密码</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
              disabled={busy}
            />
            <button type="submit" disabled={busy}>
              {busy ? "正在登录…" : "登录工作台"}
            </button>
          </form>
        )}
        {status === "error" && (
          <div className={styles.form}>
            <button type="button" disabled={busy} onClick={() => void check()}>
              重新检查连接与登录状态
            </button>
            <button type="button" disabled={busy} onClick={() => void logout()}>
              重试退出登录
            </button>
          </div>
        )}
        <p className={styles.note}>
          请勿共享账号或将 MCP 令牌粘贴到网页。忘记密码时联系管理员重置。
        </p>
      </section>
    </main>
  );
}
