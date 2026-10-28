import { QueryClient } from '@tanstack/react-query'

/**
 * Cliente único de TanStack Query. Se crea FUERA de React (módulo, no hook)
 * porque `registerOfflineMutations` y el persister lo necesitan antes de montar
 * el árbol: una mutación en cola solo se puede reanudar si sus defaults ya están
 * registrados cuando se hidrata el cache.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // gcTime largo (no es el staleTime): mantiene las consultas en cache para
      // que la persistencia en localStorage tenga algo que hidratar aunque pasen
      // días entre sesiones. Es lo que hace que la app abra con datos sin red.
      gcTime: 1000 * 60 * 60 * 24 * 14, // 14 días
      retry: 1,
      // Refrescar al volver a la pestaña dispara ráfagas de consultas en móvil
      // cada vez que se cambia de app. Los datos ya se invalidan al mutar.
      refetchOnWindowFocus: false,
    },
    mutations: {
      // 'always': sin red la mutación FALLA RÁPIDO (mutateAsync rechaza y el
      // catch enseña el error) en vez de quedarse colgada sin explicación.
      // La única mutación que sí debe encolarse offline sobrescribe esto a
      // 'online' en @/lib/offline.
      networkMode: 'always',
    },
  },
})
