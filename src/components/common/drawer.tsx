"use client";

import { ModalCore, type ModalProps } from "@/components/common/modal-core";

export type DrawerProps = ModalProps;

/** 复用 Modal 的语义与键盘合同，仅将卡面固定为右侧全高布局。 */
export function Drawer(props: DrawerProps) {
  return <ModalCore {...props} surface="drawer" />;
}
