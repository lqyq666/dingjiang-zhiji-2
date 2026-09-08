"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useEmployeeSession } from "./components/session-gate";
import { roleHome } from "./lib/session-policy";
export default function HomePage() {
  const { user } = useEmployeeSession();
  const router = useRouter();
  useEffect(() => {
    router.replace(user ? roleHome(user.role) : "/boss");
  }, [router, user]);
  return <p role="status">正在打开你的工作台…</p>;
}
