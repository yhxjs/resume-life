"use client";

import { useRef, useState } from "react";

function isNativeComposing(e: React.SyntheticEvent): boolean {
  return Boolean(
    e &&
    e.nativeEvent &&
    typeof e.nativeEvent === "object" &&
    "isComposing" in e.nativeEvent &&
    (e.nativeEvent as { isComposing?: boolean }).isComposing
  );
}

/**
 * 中文输入法（IME Composition）与即时输入解耦 Hook。
 * 在输入拼音但未确认选词期间，不向外部提交 keyword，避免触发无效的网络检索。
 */
export function useCompositionInput(
  initialValue: string = "",
  onCommit: (val: string) => void
) {
  const [value, setValue] = useState(initialValue);
  const isComposingRef = useRef(false);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setValue(val);
    if (isComposingRef.current || isNativeComposing(e)) {
      return;
    }
    onCommit(val);
  };

  const onCompositionStart = () => {
    isComposingRef.current = true;
  };

  const onCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    isComposingRef.current = false;
    const val = e.currentTarget.value;
    setValue(val);
    onCommit(val);
  };

  return {
    value,
    setValue,
    isComposingRef,
    bind: {
      value,
      onChange,
      onCompositionStart,
      onCompositionEnd,
    },
  };
}
