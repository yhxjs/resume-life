"use client";

import { ModalCore, type ModalProps } from "@/components/common/modal-core";

export type { ModalProps } from "@/components/common/modal-core";

export function Modal(props: ModalProps) {
  return <ModalCore {...props} surface="default" />;
}
