import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/useTheme';
import { GripVertical, Star } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { getTabId } from '@/lib/settings-sync';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isTelegramMiniApp, hapticFeedback } from '@/lib/telegram-webapp';

interface LocationItem {
  id: number;
  name: string;
  city: string;
  queueId: string;
  isPrimary: boolean;
  street?: string;
  houseNumber?: string;
}

function getLocationEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('дім') || n.includes('дом') || n.includes('home')) return '🏠';
  if (n.includes('робот') || n.includes('офіс') || n.includes('work')) return '🏢';
  if (n.includes('батьк') || n.includes('мам') || n.includes('тат')) return '❤️';
  if (n.includes('навч') || n.includes('універ') || n.includes('школ')) return '🎓';
  if (n.includes('дач') || n.includes('село')) return '🏡';
  return '📍';
}

function SortableLocationRow({ 
  location, 
  index, 
  isActive,
  isDragging,
}: { 
  location: LocationItem; 
  index: number; 
  isActive: boolean;
  isDragging: boolean;
}) {
  const { isLight } = useTheme();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isThisDragging,
  } = useSortable({ id: location.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isThisDragging ? 50 : undefined,
  };

  const isPrimary = index === 0;

  return (
    <motion.div
      ref={setNodeRef}
      layout={!isDragging}
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all duration-200",
        isThisDragging 
          ? "shadow-xl scale-[1.03]" 
          : "shadow-none",
        isLight
          ? cn(
              "bg-white border-zinc-200",
              isThisDragging && "border-zinc-300 shadow-zinc-200/50",
              isActive && "ring-2 ring-offset-1",
            )
          : cn(
              "bg-zinc-900/60 border-white/10",
              isThisDragging && "border-white/20 shadow-black/30",
              isActive && "ring-2 ring-offset-1 ring-offset-zinc-950",
            )
      )}
      style={{
        ...style,
        ...(isActive ? { 
          '--tw-ring-color': 'var(--accent-hex, #10b981)',
        } as React.CSSProperties : {}),
      }}
      data-testid={`prioritizer-location-${location.id}`}
    >
      <button
        className={cn(
          "touch-none cursor-grab active:cursor-grabbing p-1 -ml-1 rounded-lg transition-colors",
          isLight ? "text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
        )}
        {...attributes}
        {...listeners}
        data-testid={`drag-handle-${location.id}`}
      >
        <GripVertical className="w-5 h-5" />
      </button>

      <span className="text-lg shrink-0">{getLocationEmoji(location.name)}</span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn(
            "text-sm font-semibold truncate",
            isLight ? "text-zinc-900" : "text-white"
          )}>
            {location.name}
          </span>
          {isPrimary && (
            <span 
              className="shrink-0 text-amber-400"
              title="Основна локація"
            >
              <Star className="w-3.5 h-3.5 fill-amber-400" />
            </span>
          )}
        </div>
        <div className={cn(
          "text-xs truncate mt-0.5",
          isLight ? "text-zinc-500" : "text-zinc-400"
        )}>
          {location.city} · черга {location.queueId}
          {location.street && ` · ${location.street}`}
        </div>
      </div>

      <div className={cn(
        "shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
        isPrimary
          ? "text-white"
          : isLight
            ? "bg-zinc-100 text-zinc-500"
            : "bg-white/10 text-zinc-400"
      )}
        style={isPrimary ? { background: 'var(--accent-hex, #10b981)' } : undefined}
      >
        {index + 1}
      </div>
    </motion.div>
  );
}

interface LocationPrioritizerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locations: LocationItem[];
  activeLocationId: number | null;
  onReorder: (reorderedLocations: LocationItem[]) => void;
}

export function LocationPrioritizer({ 
  open, 
  onOpenChange, 
  locations, 
  activeLocationId,
  onReorder,
}: LocationPrioritizerProps) {
  const { isLight } = useTheme();
  const [items, setItems] = useState<LocationItem[]>(locations);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (open) {
      setItems(locations);
      setHasChanges(false);
    }
  }, [open, locations]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 80, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingId(event.active.id as number);
    if (isTelegramMiniApp()) hapticFeedback('medium');
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    setItems(prev => {
      const oldIndex = prev.findIndex(i => i.id === active.id);
      const newIndex = prev.findIndex(i => i.id === over.id);
      const newItems = arrayMove(prev, oldIndex, newIndex);
      return newItems;
    });
    setHasChanges(true);
    if (isTelegramMiniApp()) hapticFeedback('light');
  }, []);

  const saveOrder = useCallback(async () => {
    const tabId = getTabId();
    const orderedIds = items.map(i => i.id);
    const newPrimaryId = items[0]?.id;

    if (newPrimaryId) {
      const reorderedItems = items.map((item, idx) => ({
        ...item,
        isPrimary: idx === 0,
        orderIndex: idx,
      }));
      onReorder(reorderedItems);
    }

    try {
      await fetch('/api/user/locations-reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds, _tabId: tabId }),
      });

      if (newPrimaryId) {
        await fetch(`/api/user/locations/${newPrimaryId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPrimary: true, orderIndex: 0, _tabId: tabId }),
        });
      }
    } catch {}

    setHasChanges(false);
  }, [items, onReorder]);

  const handleClose = useCallback((nextOpen: boolean) => {
    if (!nextOpen && hasChanges) {
      saveOrder();
    }
    onOpenChange(nextOpen);
  }, [hasChanges, saveOrder, onOpenChange]);

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent 
        side="bottom" 
        className={cn(
          "rounded-t-3xl max-h-[75vh] overflow-hidden flex flex-col border-t",
          isLight 
            ? "bg-zinc-50 border-zinc-200" 
            : "bg-zinc-950 border-white/10"
        )}
      >
        <div className="w-10 h-1 rounded-full bg-zinc-400/40 mx-auto mb-2 mt-1 shrink-0" />
        
        <SheetHeader className="shrink-0 pb-2">
          <SheetTitle className={cn(
            "text-base font-bold text-center",
            isLight ? "text-zinc-900" : "text-white"
          )}>
            Пріоритет локацій
          </SheetTitle>
          <SheetDescription className={cn(
            "text-xs text-center",
            isLight ? "text-zinc-500" : "text-zinc-400"
          )}>
            Перетягніть для зміни порядку. Перша — основна.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto py-2 space-y-2 px-1">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
              {items.map((loc, index) => (
                <SortableLocationRow
                  key={loc.id}
                  location={loc}
                  index={index}
                  isActive={loc.id === activeLocationId}
                  isDragging={draggingId !== null}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        {hasChanges && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="shrink-0 pt-3 pb-2"
          >
            <button
              onClick={() => { saveOrder(); onOpenChange(false); }}
              className={cn(
                "w-full py-3 rounded-2xl text-sm font-semibold text-white transition-all duration-200 active:scale-[0.98]"
              )}
              style={{ background: 'var(--accent-hex, #10b981)' }}
              data-testid="button-save-priority"
            >
              Зберегти порядок
            </button>
          </motion.div>
        )}
      </SheetContent>
    </Sheet>
  );
}
