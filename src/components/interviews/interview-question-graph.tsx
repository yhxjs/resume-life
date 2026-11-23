"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { btnGhost, btnPrimary } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { fetchSse } from "@/lib/fetch-sse";
import { jsonFetch } from "@/lib/fetcher";
import {
  INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT,
  INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT,
  INTERVIEW_QUESTION_GRAPH_MAX_DEPTH,
  collectInterviewQuestionGraphTexts,
  collectInterviewQuestionGraphTextsExcludingDescendants,
  createInterviewQuestionGraphRoot,
  expandInterviewQuestionGraph,
  findInterviewQuestionGraphNode,
  parseInterviewQuestionGraphDocument,
  predictInterviewQuestionGraphAnswers,
  validateInterviewQuestionGraphCreated,
  validateInterviewQuestionGraphExpanded,
  validateInterviewQuestionGraphPredicted,
  type InterviewQuestionGraphNode,
  type SavedInterviewQuestionGraph,
} from "@/lib/interview-question-graph";
import type { InterviewStyleKey } from "@/lib/interview";

const QUESTION_NODE_WIDTH = 288;
const QUESTION_NODE_HEIGHT = 204;
const ANSWER_NODE_WIDTH = 256;
const ANSWER_NODE_HEIGHT = 204;
const COLUMN_GAP = 52;
const ROW_GAP = 54;
const GRAPH_PADDING = 40;
const MINIMAP_WIDTH = 220;
const MINIMAP_HEIGHT = 144;
const MINIMAP_PADDING = 10;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.8;

type NodeOffset = { x: number; y: number };
type QuestionLayout = { node: InterviewQuestionGraphNode; x: number; y: number };
type AnswerLayout = { id: string; label: string; predictedAnswer: string; x: number; y: number };
type GraphEdge = { id: string; fromId: string; toId: string; from: { x: number; y: number }; to: { x: number; y: number } };
type GraphLayout = { questions: QuestionLayout[]; answers: AnswerLayout[]; edges: GraphEdge[]; width: number; height: number };
type CanvasInteraction =
  | { kind: "pan"; pointerX: number; pointerY: number; viewX: number; viewY: number }
  | { kind: "node"; id: string; pointerX: number; pointerY: number; offset: NodeOffset; zoom: number };

function layoutInterviewGraph(root: InterviewQuestionGraphNode): GraphLayout {
  const questions: QuestionLayout[] = [];
  const answers: AnswerLayout[] = [];
  const edges: GraphEdge[] = [];

  function measure(node: InterviewQuestionGraphNode): number {
    const rows = node.branches.length > 0
      ? node.branches.map((branch) => Math.max(ANSWER_NODE_HEIGHT, measure(branch.followup)))
      : (node.predictedAnswers ?? []).map(() => ANSWER_NODE_HEIGHT);
    if (rows.length === 0) return QUESTION_NODE_HEIGHT;
    return Math.max(QUESTION_NODE_HEIGHT, rows.reduce((total, rowHeight) => total + rowHeight, 0) + Math.max(0, rows.length - 1) * ROW_GAP);
  }

  function place(node: InterviewQuestionGraphNode, x: number, top: number, height: number) {
    const y = top + (height - QUESTION_NODE_HEIGHT) / 2;
    questions.push({ node, x, y });
    let rowTop = top;
    for (const branch of node.branches) {
      const childHeight = measure(branch.followup);
      const rowHeight = Math.max(ANSWER_NODE_HEIGHT, childHeight);
      const answerX = x + QUESTION_NODE_WIDTH + COLUMN_GAP;
      const answerY = rowTop + (rowHeight - ANSWER_NODE_HEIGHT) / 2;
      const childX = answerX + ANSWER_NODE_WIDTH + COLUMN_GAP;
      const childTop = rowTop + (rowHeight - childHeight) / 2;
      const childY = childTop + (childHeight - QUESTION_NODE_HEIGHT) / 2;

      answers.push({ id: branch.id, label: branch.label, predictedAnswer: branch.predictedAnswer, x: answerX, y: answerY });
      edges.push({
        id: `${node.id}-${branch.id}`,
        fromId: node.id,
        toId: branch.id,
        from: { x: x + QUESTION_NODE_WIDTH, y: y + QUESTION_NODE_HEIGHT / 2 },
        to: { x: answerX, y: answerY + ANSWER_NODE_HEIGHT / 2 },
      });
      edges.push({
        id: `${branch.id}-${branch.followup.id}`,
        fromId: branch.id,
        toId: branch.followup.id,
        from: { x: answerX + ANSWER_NODE_WIDTH, y: answerY + ANSWER_NODE_HEIGHT / 2 },
        to: { x: childX, y: childY + QUESTION_NODE_HEIGHT / 2 },
      });
      place(branch.followup, childX, childTop, childHeight);
      rowTop += rowHeight + ROW_GAP;
    }
    for (const answer of node.predictedAnswers ?? []) {
      const answerX = x + QUESTION_NODE_WIDTH + COLUMN_GAP;
      const answerY = rowTop + (ANSWER_NODE_HEIGHT - ANSWER_NODE_HEIGHT) / 2;
      answers.push({ id: answer.id, label: answer.label, predictedAnswer: answer.predictedAnswer, x: answerX, y: answerY });
      edges.push({
        id: `${node.id}-${answer.id}`,
        fromId: node.id,
        toId: answer.id,
        from: { x: x + QUESTION_NODE_WIDTH, y: y + QUESTION_NODE_HEIGHT / 2 },
        to: { x: answerX, y: answerY + ANSWER_NODE_HEIGHT / 2 },
      });
      rowTop += ANSWER_NODE_HEIGHT + ROW_GAP;
    }
  }

  const height = measure(root);
  place(root, GRAPH_PADDING, GRAPH_PADDING, height);
  const width = Math.max(...[
    ...questions.map(({ x }) => x + QUESTION_NODE_WIDTH),
    ...answers.map(({ x }) => x + ANSWER_NODE_WIDTH),
  ]) + GRAPH_PADDING;
  return { questions, answers, edges, width, height: height + GRAPH_PADDING * 2 };
}

function graphBounds(layout: GraphLayout, offsets: Record<string, NodeOffset>) {
  const nodes = [
    ...layout.questions.map(({ node, x, y }) => ({ id: node.id, x, y, width: QUESTION_NODE_WIDTH, height: QUESTION_NODE_HEIGHT })),
    ...layout.answers.map(({ id, x, y }) => ({ id, x, y, width: ANSWER_NODE_WIDTH, height: ANSWER_NODE_HEIGHT })),
  ];
  return nodes.reduce((bounds, node) => {
    const offset = offsets[node.id] ?? { x: 0, y: 0 };
    const x = node.x + offset.x;
    const y = node.y + offset.y;
    return {
      minX: Math.min(bounds.minX, x),
      minY: Math.min(bounds.minY, y),
      maxX: Math.max(bounds.maxX, x + node.width),
      maxY: Math.max(bounds.maxY, y + node.height),
    };
  }, { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY });
}

function QuestionTree({ node, x, y, offset, busy, loading, dragging, onExpand, onPointerDown, onKeyDown }: {
  node: InterviewQuestionGraphNode;
  x: number;
  y: number;
  offset: NodeOffset;
  busy: boolean;
  loading: boolean;
  dragging: boolean;
  onExpand: (questionId: string, action: "expand" | "predict") => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>, id: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>, id: string) => void;
}) {
  const expandable = node.depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH - 1 || node.depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH;
  const hasGeneratedContent = node.depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH
    ? (node.predictedAnswers?.length ?? 0) > 0
    : node.branches.length > 0;
  const action = node.depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH ? "predict" : "expand";
  const actionLabel = action === "predict" ? "预测回答" : "后续分支";
  return (
    <article
      data-graph-question="true"
      data-graph-node-id={node.id}
      aria-busy={loading}
      tabIndex={0}
      aria-label={`问题节点：${node.question}`}
      onPointerDown={(event) => onPointerDown(event, node.id)}
      onKeyDown={(event) => onKeyDown(event, node.id)}
      className={`pointer-events-auto absolute z-10 flex flex-col rounded-md border bg-card p-4 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-primary ${loading ? "border-primary ring-2 ring-primary/30 shadow-md" : "border-line"} ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
      style={{ left: x + offset.x, top: y + offset.y, width: QUESTION_NODE_WIDTH, height: QUESTION_NODE_HEIGHT }}
    >
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-muted">
          <span aria-hidden="true" className="select-none text-faint">⠿</span>
          <span className="font-mono text-primary">第 {node.depth} 层</span>
          <span className="text-faint">{node.depth === 1 ? "主问题" : "追问"}</span>
        </div>
        {expandable && (
          <button
            type="button"
            aria-label={loading
              ? `正在为“${node.question}”生成${actionLabel}`
              : hasGeneratedContent
                ? `重新生成“${node.question}”的${actionLabel}`
                : `为“${node.question}”生成${action === "predict" ? "预测回答" : "分支"}`}
            title={loading ? `正在生成${actionLabel}` : hasGeneratedContent ? `重新生成此题的${actionLabel}` : action === "predict" ? "生成此题的预测回答" : "生成此题的回答与追问分支"}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-lg leading-none text-primary transition hover:border-primary hover:bg-primary/10 disabled:cursor-wait disabled:opacity-50"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onExpand(node.id, action)}
            disabled={busy}
          >
            {loading
              ? <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-primary border-r-transparent motion-reduce:animate-none" />
              : <span aria-hidden="true">{hasGeneratedContent ? "↻" : "+"}</span>}
          </button>
        )}
      </div>
      <p data-node-scroll="true" className="mt-2 min-h-0 flex-1 overflow-auto whitespace-pre-wrap text-sm leading-6 text-ink">{node.question}</p>
      {loading
        ? <p role="status" className="mt-2 flex shrink-0 items-center gap-2 text-xs font-medium text-primary"><span className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />{action === "predict" ? "正在生成预测回答…" : "正在生成回答与追问…"}</p>
        : expandable && <p className="mt-2 shrink-0 text-xs text-muted">{hasGeneratedContent ? action === "predict" ? "预测回答已生成 · 可重新生成" : "追问已生成 · 可重新生成" : action === "predict" ? "待生成预测回答" : "待扩展"}</p>}
    </article>
  );
}

type StoredGraph = {
  configKey: string;
  recordId: number;
  revision: number;
  root: InterviewQuestionGraphNode;
  history: InterviewQuestionGraphNode[];
};

type PendingQuestion = {
  node: InterviewQuestionGraphNode;
  parentQuestion: string;
  answerScenario: string;
};

function storedGraphFromRecord(record: SavedInterviewQuestionGraph | null): StoredGraph | null {
  if (!record) return null;
  return {
    configKey: JSON.stringify([record.resume_id, record.resume_version_id ?? "", record.jd.trim(), record.style]),
    recordId: record.id,
    revision: record.revision,
    root: record.graph,
    history: record.history,
  };
}

function findPending(node: InterviewQuestionGraphNode, result: PendingQuestion[] = []): PendingQuestion[] {
  if (node.depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH - 1 && node.branches.length === 0 && node.parentQuestion && node.answerScenario) {
    result.push({ node, parentQuestion: node.parentQuestion, answerScenario: node.answerScenario });
  }
  for (const branch of node.branches) findPending(branch.followup, result);
  return result;
}

function findPendingPredictions(node: InterviewQuestionGraphNode, result: PendingQuestion[] = []): PendingQuestion[] {
  if (node.depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH && !node.predictedAnswers?.length && node.parentQuestion && node.answerScenario) {
    result.push({ node, parentQuestion: node.parentQuestion, answerScenario: node.answerScenario });
  }
  for (const branch of node.branches) findPendingPredictions(branch.followup, result);
  return result;
}

function countExpandedMiddleQuestions(node: InterviewQuestionGraphNode): number {
  return (node.depth === INTERVIEW_QUESTION_GRAPH_MAX_DEPTH - 1 && node.branches.length > 0 ? 1 : 0)
    + node.branches.reduce((count, branch) => count + countExpandedMiddleQuestions(branch.followup), 0);
}

export function InterviewQuestionGraph({
  hidden,
  disabled = false,
  resumeId,
  resumeVersionId,
  jd,
  style,
  configurationError = "",
  initialRecord = null,
  onRecordSaved,
}: {
  hidden: boolean;
  disabled?: boolean;
  resumeId: number | "";
  resumeVersionId: number | "";
  jd: string;
  style: InterviewStyleKey;
  configurationError?: string;
  initialRecord?: SavedInterviewQuestionGraph | null;
  onRecordSaved?: () => void;
}) {
  const configKey = JSON.stringify([resumeId, resumeVersionId, jd.trim(), style]);
  const [storedGraph, setStoredGraph] = useState<StoredGraph | null>(() => storedGraphFromRecord(initialRecord));
  const [busy, setBusy] = useState<"start" | "expand" | "predict" | "undo" | null>(null);
  const [expandingQuestionId, setExpandingQuestionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, NodeOffset>>({});
  const [view, setView] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [draggingNode, setDraggingNode] = useState("");
  const nodeOffsetsRef = useRef(nodeOffsets);
  const viewportRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<CanvasInteraction | null>(null);
  const previousRecordIdRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const activeGraph = storedGraph?.root ? storedGraph : null;
  const graphRoot = activeGraph?.root;
  const graphRecordId = activeGraph?.recordId;
  const layout = useMemo(() => graphRoot ? layoutInterviewGraph(graphRoot) : null, [graphRoot]);
  const graphIsCurrent = activeGraph?.configKey === configKey;
  const pending = useMemo(() => activeGraph ? findPending(activeGraph.root) : [], [activeGraph]);
  const pendingPredictions = useMemo(() => activeGraph ? findPendingPredictions(activeGraph.root) : [], [activeGraph]);
  const expandedCount = useMemo(() => activeGraph ? countExpandedMiddleQuestions(activeGraph.root) : 0, [activeGraph]);
  const canGenerate = resumeId !== "" && resumeVersionId !== "" && Boolean(jd.trim()) && !configurationError && !disabled;
  const canvasWidth = viewportSize.width || 800;
  const canvasHeight = viewportSize.height || 600;
  const bounds = layout ? graphBounds(layout, nodeOffsets) : null;
  const boundsWidth = bounds ? Math.max(1, bounds.maxX - bounds.minX) : 1;
  const boundsHeight = bounds ? Math.max(1, bounds.maxY - bounds.minY) : 1;
  const minimapScale = Math.min((MINIMAP_WIDTH - MINIMAP_PADDING * 2) / boundsWidth, (MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / boundsHeight);
  const minimapDisplayWidth = Math.min(MINIMAP_WIDTH, Math.max(128, canvasWidth * 0.54));
  const minimapDisplayHeight = MINIMAP_HEIGHT * minimapDisplayWidth / MINIMAP_WIDTH;

  const fitCanvas = useCallback((offsets: Record<string, NodeOffset>) => {
    if (!layout || !viewportRef.current) return;
    const { width, height } = viewportRef.current.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    const fittedBounds = graphBounds(layout, offsets);
    const contentWidth = Math.max(1, fittedBounds.maxX - fittedBounds.minX);
    const contentHeight = Math.max(1, fittedBounds.maxY - fittedBounds.minY);
    const nextZoom = Math.max(MIN_ZOOM, Math.min(1.2, (width - 64) / contentWidth, (height - 64) / contentHeight));
    const scaledWidth = contentWidth * nextZoom;
    const scaledHeight = contentHeight * nextZoom;
    setZoom(nextZoom);
    setView({
      x: (scaledWidth <= width - 64 ? (width - scaledWidth) / 2 : 32) - fittedBounds.minX * nextZoom,
      y: (scaledHeight <= height - 64 ? (height - scaledHeight) / 2 : 32) - fittedBounds.minY * nextZoom,
    });
  }, [layout]);

  const zoomAt = useCallback((nextZoom: number, point?: { x: number; y: number }) => {
    const element = viewportRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const width = rect.width || canvasWidth;
    const height = rect.height || canvasHeight;
    const x = point?.x ?? width / 2;
    const y = point?.y ?? height / 2;
    const safeZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    const worldX = (x - view.x) / zoom;
    const worldY = (y - view.y) / zoom;
    setView({ x: x - worldX * safeZoom, y: y - worldY * safeZoom });
    setZoom(safeZoom);
  }, [canvasHeight, canvasWidth, view.x, view.y, zoom]);

  function capturePointer(pointerId: number) {
    const element = viewportRef.current;
    if (element && typeof element.setPointerCapture === "function") element.setPointerCapture(pointerId);
  }

  function beginNodeDrag(event: React.PointerEvent<HTMLElement>, id: string) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event.pointerId);
    interactionRef.current = {
      kind: "node",
      id,
      pointerX: event.clientX,
      pointerY: event.clientY,
      offset: nodeOffsets[id] ?? { x: 0, y: 0 },
      zoom,
    };
    setDraggingNode(id);
  }

  function beginPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.button !== 0) return;
    event.preventDefault();
    capturePointer(event.pointerId);
    interactionRef.current = { kind: "pan", pointerX: event.clientX, pointerY: event.clientY, viewX: view.x, viewY: view.y };
  }

  function moveInteraction(event: React.PointerEvent<HTMLDivElement>) {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const deltaX = event.clientX - interaction.pointerX;
    const deltaY = event.clientY - interaction.pointerY;
    if (interaction.kind === "pan") {
      setView({ x: interaction.viewX + deltaX, y: interaction.viewY + deltaY });
      return;
    }
    setNodeOffsets((current) => ({
      ...current,
      [interaction.id]: { x: interaction.offset.x + deltaX / interaction.zoom, y: interaction.offset.y + deltaY / interaction.zoom },
    }));
  }

  function endInteraction() {
    interactionRef.current = null;
    setDraggingNode("");
  }

  function moveNodeWithKeyboard(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    const directions: Record<string, NodeOffset> = {
      ArrowUp: { x: 0, y: -20 },
      ArrowDown: { x: 0, y: 20 },
      ArrowLeft: { x: -20, y: 0 },
      ArrowRight: { x: 20, y: 0 },
    };
    const delta = directions[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const multiplier = event.shiftKey ? 3 : 1;
    setNodeOffsets((current) => {
      const offset = current[id] ?? { x: 0, y: 0 };
      return { ...current, [id]: { x: offset.x + delta.x * multiplier, y: offset.y + delta.y * multiplier } };
    });
  }

  function locateFromMinimap(event: React.MouseEvent<HTMLButtonElement>) {
    if (!bounds || !viewportRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.detail === 0 ? MINIMAP_WIDTH / 2 : (event.clientX - rect.left) / rect.width * MINIMAP_WIDTH;
    const localY = event.detail === 0 ? MINIMAP_HEIGHT / 2 : (event.clientY - rect.top) / rect.height * MINIMAP_HEIGHT;
    if (rect.width < 1 || rect.height < 1 || minimapScale <= 0) return;
    const worldX = bounds.minX + (localX - MINIMAP_PADDING) / minimapScale;
    const worldY = bounds.minY + (localY - MINIMAP_PADDING) / minimapScale;
    setView({ x: canvasWidth / 2 - worldX * zoom, y: canvasHeight / 2 - worldY * zoom });
  }


  useEffect(() => {
    nodeOffsetsRef.current = nodeOffsets;
  }, [nodeOffsets]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateSize);
    observer?.observe(element);
    window.addEventListener("resize", updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = element.getBoundingClientRect();
      zoomAt(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [zoom, zoomAt]);

  useEffect(() => {
    if (graphRecordId === undefined || !graphRoot || hidden) return;
    const recordChanged = previousRecordIdRef.current !== graphRecordId;
    previousRecordIdRef.current = graphRecordId;
    if (!recordChanged) return;
    setNodeOffsets({});
    const frame = window.requestAnimationFrame(() => fitCanvas({}));
    return () => window.cancelAnimationFrame(frame);
  }, [fitCanvas, graphRecordId, graphRoot, hidden]);

  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  async function requestGraph(action: "start" | "expand" | "predict", questionId?: string) {
    if (!canGenerate || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(action);
    setExpandingQuestionId(action === "start" ? null : questionId ?? null);
    setError("");
    const baseBody = {
      resume_id: resumeId,
      resume_version_id: resumeVersionId,
      jd: jd.trim(),
      style,
    };
    try {
      if (action === "start") {
        await fetchSse<unknown>("/api/interviews/question-graph", {
          signal: controller.signal,
          body: { action, ...baseBody },
          onDone: (response) => {
            const result = validateInterviewQuestionGraphCreated(response);
            if (requestRef.current !== controller) return;
            const root = createInterviewQuestionGraphRoot(result);
            setStoredGraph({ configKey, recordId: result.graph_id, revision: result.revision, root, history: [] });
            onRecordSaved?.();
          },
        });
      } else {
        if (!activeGraph || !graphIsCurrent || !questionId) return;
        const node = findInterviewQuestionGraphNode(activeGraph.root, questionId);
        const expectedDepth: 2 | 3 = action === "expand" ? 2 : INTERVIEW_QUESTION_GRAPH_MAX_DEPTH;
        if (!node || node.depth !== expectedDepth || !node.parentQuestion || !node.answerScenario) return;
        const next = { node, parentQuestion: node.parentQuestion, answerScenario: node.answerScenario };
        const knownQuestions = collectInterviewQuestionGraphTexts(activeGraph.root);
        const replacementKnownQuestions = action === "expand"
          ? collectInterviewQuestionGraphTextsExcludingDescendants(activeGraph.root, [next.node.id])
          : knownQuestions;
        await fetchSse<unknown>("/api/interviews/question-graph", {
          signal: controller.signal,
          body: {
            action,
            ...baseBody,
            graph_id: activeGraph.recordId,
            revision: activeGraph.revision,
            known_questions: knownQuestions,
            frontier: [{
              question_id: next.node.id,
              depth: expectedDepth,
              question: next.node.question,
              parent_question: next.parentQuestion,
              answer_scenario: next.answerScenario,
            }],
          },
          onDone: (response) => {
            if (action === "expand") {
              const result = validateInterviewQuestionGraphExpanded(response, [next.node.id], replacementKnownQuestions, activeGraph.recordId);
              if (requestRef.current !== controller) return;
              if (result.revision !== activeGraph.revision + 1) throw new Error("图谱版本已变化，请重新载入历史记录");
              const expansion = result.expansions[0];
              if (!expansion) throw new Error("服务器没有返回对应的追问分支，请重试");
              setStoredGraph((current) => {
                if (current?.configKey !== configKey) return current;
                const root = expandInterviewQuestionGraph(current.root, [expansion]);
                return root === current.root ? current : {
                  ...current,
                  root,
                  revision: result.revision,
                  history: [...current.history, current.root].slice(-INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT),
                };
              });
            } else {
              const result = validateInterviewQuestionGraphPredicted(response, [next.node.id], activeGraph.recordId);
              if (requestRef.current !== controller) return;
              if (result.revision !== activeGraph.revision + 1) throw new Error("图谱版本已变化，请重新载入历史记录");
              const prediction = result.predictions[0];
              if (!prediction) throw new Error("服务器没有返回对应的预测回答，请重试");
              setStoredGraph((current) => {
                if (current?.configKey !== configKey) return current;
                const root = predictInterviewQuestionGraphAnswers(current.root, [prediction]);
                return root === current.root ? current : {
                  ...current,
                  root,
                  revision: result.revision,
                  history: [...current.history, current.root].slice(-INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT),
                };
              });
            }
            onRecordSaved?.();
          },
        });
      }
    } catch (reason) {
      if (controller.signal.aborted || requestRef.current !== controller) return;
      setError(errorMessage(reason));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(null);
        setExpandingQuestionId(null);
      }
    }
  }

  async function undoLastExpansion() {
    if (!activeGraph?.history.length || busy) return;
    setBusy("undo");
    setError("");
    try {
      const response = await jsonFetch<unknown>(`/api/interviews/question-graphs/${activeGraph.recordId}/undo`, {
        method: "POST",
        body: JSON.stringify({ expected_revision: activeGraph.revision }),
        cache: "no-store",
      });
      if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("撤销响应无效，请重新载入历史记录");
      const value = response as Record<string, unknown>;
      if (!Number.isSafeInteger(value.revision) || value.revision !== activeGraph.revision + 1 || !Array.isArray(value.history) || value.history.length > INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT) {
        throw new Error("撤销响应与当前图谱版本不符，请重新载入历史记录");
      }
      const root = parseInterviewQuestionGraphDocument(value.graph);
      const history = value.history.map(parseInterviewQuestionGraphDocument);
      setStoredGraph((current) => current?.recordId === activeGraph.recordId
        ? { ...current, root, history, revision: value.revision as number }
        : current);
      onRecordSaved?.();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section hidden={hidden} aria-labelledby="interview-question-graph-title" className="space-y-5 border-t border-line pt-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="interview-question-graph-title" className="font-serif text-xl font-bold text-ink">面试题目图谱</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">最多 {INTERVIEW_QUESTION_GRAPH_MAX_DEPTH} 层、每题 {INTERVIEW_QUESTION_GRAPH_BRANCH_LIMIT} 条回答分支。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeGraph && activeGraph.history.length > 0 && (
            <button type="button" className={btnGhost} onClick={() => void undoLastExpansion()} disabled={busy !== null}>
              撤销上一步
            </button>
          )}
          <button type="button" className={btnPrimary} onClick={() => void requestGraph("start")} disabled={!canGenerate || busy !== null}>
            {busy === "start" ? "正在生成题目图谱…" : activeGraph ? "重新生成图谱" : "一键生成题目图谱"}
          </button>
          {activeGraph && graphIsCurrent && busy === null && (
            <span className="text-xs font-medium text-accent">
              {[
                pending.length > 0 ? `待扩展 ${pending.length} 个追问` : "",
                pendingPredictions.length > 0 ? `待生成 ${pendingPredictions.length} 个预测回答` : "",
                expandedCount > 0 ? `已扩展 ${expandedCount} 个追问` : "",
              ].filter(Boolean).join(" · ") || `图谱已完善至第 ${INTERVIEW_QUESTION_GRAPH_MAX_DEPTH} 层`}
            </span>
          )}
        </div>
      </div>

      {activeGraph && !graphIsCurrent && (
        <div role="status" className="border-l-2 border-accent px-3 py-2 text-sm text-accent">
          当前简历、JD 或面试官风格已变化。现有图谱保留供查看；重新生成后才能继续扩展。
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {busy && <p role="status" className="text-xs text-muted">{busy === "undo" ? "正在撤销并保存图谱…" : busy === "predict" ? "正在依据当前发布简历和岗位要求生成预测回答，历史记录会同步保存。" : "正在依据当前发布简历和岗位要求生成分支，历史记录会同步保存。"}</p>}
      {activeGraph && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div role="group" aria-label="图谱缩放" className="flex h-fit items-center gap-1 rounded-md border border-line bg-card p-1">
            <button type="button" aria-label="缩小图谱" title="缩小" onClick={() => zoomAt(zoom / 1.2)} className="inline-flex size-8 items-center justify-center rounded text-lg text-ink hover:bg-surface">−</button>
            <span aria-live="polite" className="min-w-12 text-center font-mono text-xs text-muted">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label="放大图谱" title="放大" onClick={() => zoomAt(zoom * 1.2)} className="inline-flex size-8 items-center justify-center rounded text-lg text-ink hover:bg-surface">+</button>
            <span className="mx-1 h-5 border-l border-line" />
            <button type="button" aria-label="适配画布" title="适配画布" onClick={() => fitCanvas(nodeOffsets)} className="inline-flex size-8 items-center justify-center rounded text-sm font-semibold text-primary hover:bg-surface">适配</button>
          </div>

          {layout && bounds && (
            <div role="group" aria-label="图谱小地图" className="shrink-0">
              <button
                type="button"
                aria-label="点击小地图定位画布"
                title="小地图 · 点击定位"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={locateFromMinimap}
                className="block overflow-hidden rounded-md border border-line bg-card p-0 text-muted shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{ width: minimapDisplayWidth, height: minimapDisplayHeight }}
              >
                <svg aria-hidden="true" viewBox={`0 0 ${MINIMAP_WIDTH} ${MINIMAP_HEIGHT}`} className="block size-full">
                  {layout.edges.map((edge) => {
                    const fromOffset = nodeOffsets[edge.fromId] ?? { x: 0, y: 0 };
                    const toOffset = nodeOffsets[edge.toId] ?? { x: 0, y: 0 };
                    const fromX = MINIMAP_PADDING + (edge.from.x + fromOffset.x - bounds.minX) * minimapScale;
                    const fromY = MINIMAP_PADDING + (edge.from.y + fromOffset.y - bounds.minY) * minimapScale;
                    const toX = MINIMAP_PADDING + (edge.to.x + toOffset.x - bounds.minX) * minimapScale;
                    const toY = MINIMAP_PADDING + (edge.to.y + toOffset.y - bounds.minY) * minimapScale;
                    return <line key={edge.id} x1={fromX} y1={fromY} x2={toX} y2={toY} stroke="currentColor" strokeWidth="1" />;
                  })}
                  {layout.questions.map(({ node, x, y }) => {
                    const offset = nodeOffsets[node.id] ?? { x: 0, y: 0 };
                    return <rect key={node.id} x={MINIMAP_PADDING + (x + offset.x - bounds.minX) * minimapScale} y={MINIMAP_PADDING + (y + offset.y - bounds.minY) * minimapScale} width={QUESTION_NODE_WIDTH * minimapScale} height={QUESTION_NODE_HEIGHT * minimapScale} rx="2" className="fill-primary/55" />;
                  })}
                  {layout.answers.map((answer) => {
                    const offset = nodeOffsets[answer.id] ?? { x: 0, y: 0 };
                    return <rect key={answer.id} x={MINIMAP_PADDING + (answer.x + offset.x - bounds.minX) * minimapScale} y={MINIMAP_PADDING + (answer.y + offset.y - bounds.minY) * minimapScale} width={ANSWER_NODE_WIDTH * minimapScale} height={ANSWER_NODE_HEIGHT * minimapScale} rx="2" className="fill-accent/55" />;
                  })}
                  <rect
                    x={MINIMAP_PADDING + (-view.x / zoom - bounds.minX) * minimapScale}
                    y={MINIMAP_PADDING + (-view.y / zoom - bounds.minY) * minimapScale}
                    width={canvasWidth / zoom * minimapScale}
                    height={canvasHeight / zoom * minimapScale}
                    fill="currentColor"
                    fillOpacity="0.08"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}
      {activeGraph ? (
        <div
          ref={viewportRef}
          role="region"
          aria-label="模拟面试问题图谱"
          tabIndex={0}
          onPointerDown={beginPan}
          onPointerMove={moveInteraction}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
              event.preventDefault();
              const step = event.shiftKey ? 72 : 36;
              setView((current) => ({
                x: current.x + (event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0),
                y: current.y + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
              }));
            } else if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              zoomAt(zoom * 1.12);
            } else if (event.key === "-") {
              event.preventDefault();
              zoomAt(zoom / 1.12);
            }
          }}
          className="relative h-[min(72vh,680px)] min-h-[480px] min-w-0 touch-none overflow-hidden rounded-md border border-line bg-surface outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {layout && bounds && (
            <div
              aria-hidden="false"
              className="pointer-events-none absolute left-0 top-0"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
            >
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute z-0 overflow-visible text-line"
                style={{ left: bounds.minX, top: bounds.minY, width: boundsWidth, height: boundsHeight }}
                viewBox={`${bounds.minX} ${bounds.minY} ${boundsWidth} ${boundsHeight}`}
              >
                {layout.edges.map((edge) => {
                  const fromOffset = nodeOffsets[edge.fromId] ?? { x: 0, y: 0 };
                  const toOffset = nodeOffsets[edge.toId] ?? { x: 0, y: 0 };
                  const fromX = edge.from.x + fromOffset.x;
                  const fromY = edge.from.y + fromOffset.y;
                  const toX = edge.to.x + toOffset.x;
                  const toY = edge.to.y + toOffset.y;
                  const curve = Math.max(28, (toX - fromX) * 0.45);
                  return <path key={edge.id} d={`M ${fromX} ${fromY} C ${fromX + curve} ${fromY}, ${toX - curve} ${toY}, ${toX} ${toY}`} fill="none" stroke="currentColor" strokeWidth="2" />;
                })}
              </svg>
              {layout.questions.map(({ node, x, y }) => (
                <QuestionTree
                  key={node.id}
                  node={node}
                  x={x}
                  y={y}
                  offset={nodeOffsets[node.id] ?? { x: 0, y: 0 }}
                  busy={busy !== null || !graphIsCurrent || !canGenerate}
                  loading={expandingQuestionId === node.id}
                  dragging={draggingNode === node.id}
                  onExpand={(questionId, action) => void requestGraph(action, questionId)}
                  onPointerDown={beginNodeDrag}
                  onKeyDown={moveNodeWithKeyboard}
                />
              ))}
              {layout.answers.map((answer) => (
                <article
                  key={answer.id}
                  data-graph-answer="true"
                  data-graph-node-id={answer.id}
                  tabIndex={0}
                  aria-label={`预测回答节点：${answer.label}`}
                  onPointerDown={(event) => beginNodeDrag(event, answer.id)}
                  onKeyDown={(event) => moveNodeWithKeyboard(event, answer.id)}
                  className={`pointer-events-auto absolute z-10 flex flex-col rounded-md border border-accent/40 bg-card p-3 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-primary ${draggingNode === answer.id ? "cursor-grabbing" : "cursor-grab"}`}
                  style={{ left: answer.x + (nodeOffsets[answer.id]?.x ?? 0), top: answer.y + (nodeOffsets[answer.id]?.y ?? 0), width: ANSWER_NODE_WIDTH, height: ANSWER_NODE_HEIGHT }}
                >
                  <p className="shrink-0 text-[11px] font-bold text-accent">{answer.label}</p>
                  <p className="mt-2 shrink-0 text-[11px] font-semibold text-muted">预测回答 · 练习假设</p>
                  <p data-node-scroll="true" className="mt-1 min-h-0 flex-1 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink">{answer.predictedAnswer}</p>
                </article>
              ))}
            </div>
          )}

        </div>
      ) : (
        <div className="border-l-2 border-primary px-4 py-3 text-sm leading-6 text-muted">
          {canGenerate ? "生成后会显示主问题、预测回答与对应追问；你可以逐轮扩展每个待完善分支。" : "请先选择已发布简历版本并填写岗位要求。"}
        </div>
      )}
    </section>
  );
}
