import { useMutation, useQueryClient } from "@tanstack/react-query";

import { applySnapshot, errorMessage, setNotice } from "@/june-view";

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => window.june.login(),
    onMutate: () => setNotice(client, undefined),
    onSuccess: (snapshot) => applySnapshot(client, snapshot),
    onError: (error) => setNotice(client, errorMessage(error)),
  });
}
