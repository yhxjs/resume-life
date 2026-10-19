import { ResumeEditor } from "@/components/resume/resume-editor";

export default async function ResumeEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ResumeEditor key={id} id={id} />;
}
