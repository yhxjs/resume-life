import { ApplicationPreparationPage } from "@/components/application/application-preparation-page";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ApplicationPreparationPage key={id} id={id} />;
}
