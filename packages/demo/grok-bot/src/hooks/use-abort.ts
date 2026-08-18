import { useMutation } from "@tanstack/react-query";

export function useAbort() {
  return useMutation({ mutationFn: () => window.june.abort() });
}
