"use client";
import { useParams } from "next/navigation";
import { ProjectRecord } from "../../components/project-record";
export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectRecord key={id} id={id} />;
}
