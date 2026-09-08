import { Suspense } from "react";

import ExperienceLibraryClient from "./experience-library-client";

export default function ExperiencesPage() {
  return (
    <Suspense fallback={<p>正在打开经验库…</p>}>
      <ExperienceLibraryClient />
    </Suspense>
  );
}
