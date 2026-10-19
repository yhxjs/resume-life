"use client";

import { ModalCore, type ModalProps } from "@/components/common/modal-core";

export function CompactModal(props: ModalProps) {
  return <ModalCore {...props} surface="compact" />;
}

export function CommandModal(props: ModalProps) {
  return <ModalCore {...props} surface="command" />;
}
