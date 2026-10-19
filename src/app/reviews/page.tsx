import { ReviewWorkbench } from "@/components/reviews/review-workbench";

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ card?: string | string[] }> }) {
  const { card } = await searchParams;
  const id = typeof card === "string" && /^\d+$/.test(card) ? Number(card) : null;
  const initialCardId = id !== null && Number.isSafeInteger(id) && id > 0 ? id : null;
  return <ReviewWorkbench key={initialCardId ?? "list"} initialCardId={initialCardId} />;
}
