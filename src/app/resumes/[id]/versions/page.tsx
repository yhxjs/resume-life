import { ResumeVersionsPage } from "@/components/resume/resume-versions-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResumeVersionsPage key={id} resumeId={id} />;
}
