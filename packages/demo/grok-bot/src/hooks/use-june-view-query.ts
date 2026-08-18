import { useQuery } from "@tanstack/react-query";

import { juneViewKey, toView } from "@/june-view";

export function useJuneViewQuery() {
  return useQuery({
    queryKey: juneViewKey,
    queryFn: async () => toView(await window.june.initialize()),
    staleTime: Infinity,
    retry: false,
  });
}
