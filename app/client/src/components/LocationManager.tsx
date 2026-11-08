import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';
import { useLocation } from 'wouter';
import { MapPin, Plus, Trash2, Edit2, Check, X, Loader2, Home, Briefcase, Heart, GraduationCap, TreePine, Search, Bell, MessageCircle, GripVertical, ChevronDown, ChevronRight, Info, Star, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { getTabId } from '@/lib/settings-sync';
import { useToast } from '@/hooks/use-toast';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface UserLocation {
  id: number;
  name: string;
  city: string;
  lookupMode: string;
  street: string;
  houseNumber: string;
  queueId: string;
  isPrimary: boolean;
  orderIndex: number;
  notifyEnabled: boolean;
  notifyBeforeOff: number;
  notifyBeforeOn: number;
  telegramNotify: boolean;
}

const PRESET_NAMES = [
  { label: 'Дім', icon: Home },
  { label: 'Робота', icon: Briefcase },
  { label: 'Батьки', icon: Heart },
  { label: 'Навчання', icon: GraduationCap },
  { label: 'Дача', icon: TreePine },
];

const CITIES = ['Київ', 'Харків', 'Одеса', 'Вінниця'];

function getLocationEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('дім') || n.includes('дом') || n.includes('home')) return '🏠';
  if (n.includes('робот') || n.includes('офіс') || n.includes('work')) return '🏢';
  if (n.includes('батьк') || n.includes('мам') || n.includes('тат')) return '❤️';
  if (n.includes('навч') || n.includes('універ') || n.includes('школ')) return '🎓';
  if (n.includes('дач') || n.includes('село')) return '🏡';
  return '📍';
}

interface LocationFormState {
  name: string;
  city: string;
  lookupMode: 'address' | 'queue';
  street: string;
  houseNumber: string;
  queueId: string;
  streetConfirmed: boolean;
  streetSuggestions: string[];
  houseSuggestions: string[];
  showStreetDropdown: boolean;
  showHouseDropdown: boolean;
  isSearchingStreet: boolean;
  isSearchingHouse: boolean;
  isDetectingQueue: boolean;
  detectedQueueId: string;
  showManualQueue: boolean;
  needsManualQueue: boolean;
}

const initialFormState: LocationFormState = {
  name: '',
  city: 'Київ',
  lookupMode: 'address',
  street: '',
  houseNumber: '',
  queueId: '',
  streetConfirmed: false,
  streetSuggestions: [],
  houseSuggestions: [],
  showStreetDropdown: false,
  showHouseDropdown: false,
  isSearchingStreet: false,
  isSearchingHouse: false,
  isDetectingQueue: false,
  detectedQueueId: '',
  showManualQueue: false,
  needsManualQueue: false,
};

interface LocationManagerProps {
  onboardingMode?: boolean;
}

export function LocationManager({ onboardingMode = false }: LocationManagerProps) {
  const { isLight } = useTheme();
  const [, navigate] = useLocation();
  const [locations, setLocations] = useState<UserLocation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(onboardingMode);
  const [editId, setEditId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [queues, setQueues] = useState<string[]>([]);
  const [showReorderHint, setShowReorderHint] = useState(false);
  const [sectionCollapsed, setSectionCollapsed] = useState(true);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();
  const store = useStore();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const [form, setForm] = useState<LocationFormState>({ ...initialFormState });

  const streetDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const houseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streetContainerRef = useRef<HTMLDivElement>(null);
  const houseContainerRef = useRef<HTMLDivElement>(null);

  const updateForm = useCallback((updates: Partial<LocationFormState>) => {
    setForm(prev => ({ ...prev, ...updates }));
  }, []);

  const fetchLocations = useCallback(async () => {
    try {
      const resp = await fetch('/api/user/locations');
      if (resp.ok) setLocations(await resp.json());
    } catch {}
    setIsLoading(false);
  }, []);

  const fetchQueues = useCallback(async (city: string) => {
    try {
      const resp = await fetch(`/api/queues?city=${encodeURIComponent(city)}`);
      if (resp.ok) {
        const data = await resp.json();
        setQueues((data.queues || data).map((q: any) => q.id || q));
      }
    } catch {}
  }, []);

  useEffect(() => { fetchLocations(); }, [fetchLocations]);

  useEffect(() => {
    if (!isLoading && onboardingMode) {
      setSectionCollapsed(false);
    }
  }, [isLoading, onboardingMode]);

  useEffect(() => {
    if (showAdd || editId !== null) fetchQueues(form.city);
  }, [form.city, showAdd, editId, fetchQueues]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (streetContainerRef.current && !streetContainerRef.current.contains(target)) {
        updateForm({ showStreetDropdown: false });
      }
      if (houseContainerRef.current && !houseContainerRef.current.contains(target)) {
        updateForm({ showHouseDropdown: false });
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [updateForm]);

  const searchStreets = useCallback(async (query: string, city: string) => {
    if (query.length < 2) {
      updateForm({ streetSuggestions: [], showStreetDropdown: false });
      return;
    }
    updateForm({ isSearchingStreet: true });
    try {
      const resp = await fetch(`/api/geocode/streets?q=${encodeURIComponent(query)}&city=${encodeURIComponent(city)}`);
      const streets = await resp.json();
      updateForm({
        streetSuggestions: streets,
        showStreetDropdown: streets.length > 0,
        isSearchingStreet: false,
      });
    } catch {
      updateForm({ isSearchingStreet: false });
    }
  }, [updateForm]);

  const searchHouseNumbers = useCallback(async (streetName: string, query: string, city: string) => {
    if (!streetName) return;
    updateForm({ isSearchingHouse: true });
    try {
      const params = new URLSearchParams({ street: streetName, city });
      if (query) params.set('q', query);
      const resp = await fetch(`/api/geocode/houses?${params}`);
      const houses = await resp.json();
      updateForm({
        houseSuggestions: houses,
        showHouseDropdown: houses.length > 0,
        isSearchingHouse: false,
      });
    } catch {
      updateForm({ isSearchingHouse: false });
    }
  }, [updateForm]);

  const detectQueue = useCallback(async (streetName: string, house: string, city: string) => {
    updateForm({ isDetectingQueue: true, detectedQueueId: '', needsManualQueue: false });
    try {
      const params = new URLSearchParams({ street: streetName, city });
      if (house) params.set('house', house);
      const resp = await fetch(`/api/address-queue?${params}`);
      const data = await resp.json();
      updateForm({
        isDetectingQueue: false,
        detectedQueueId: data.queueId || '',
        queueId: data.queueId || '',
        needsManualQueue: !!data.needsManualQueue,
        showManualQueue: !!data.needsManualQueue,
      });
    } catch {
      updateForm({ isDetectingQueue: false });
    }
  }, [updateForm]);

  const handleStreetInput = (value: string) => {
    updateForm({
      street: value,
      streetConfirmed: false,
      houseNumber: '',
      houseSuggestions: [],
      showHouseDropdown: false,
      detectedQueueId: '',
      queueId: '',
      needsManualQueue: false,
      showManualQueue: false,
    });
    if (streetDebounceRef.current) clearTimeout(streetDebounceRef.current);
    streetDebounceRef.current = setTimeout(() => {
      searchStreets(value, form.city);
    }, 150);
  };

  const handleStreetSelect = (selectedStreet: string) => {
    updateForm({
      street: selectedStreet,
      streetConfirmed: true,
      showStreetDropdown: false,
      streetSuggestions: [],
      houseNumber: '',
      houseSuggestions: [],
      detectedQueueId: '',
      queueId: '',
      needsManualQueue: false,
    });
    detectQueue(selectedStreet, '', form.city);
    searchHouseNumbers(selectedStreet, '', form.city);
  };

  const handleHouseInput = (value: string) => {
    updateForm({ houseNumber: value });
    if (houseDebounceRef.current) clearTimeout(houseDebounceRef.current);
    houseDebounceRef.current = setTimeout(() => {
      if (form.streetConfirmed && form.street) {
        searchHouseNumbers(form.street, value, form.city);
      }
    }, 250);
  };

  const handleHouseSelect = (selectedHouse: string) => {
    updateForm({
      houseNumber: selectedHouse,
      showHouseDropdown: false,
      houseSuggestions: [],
    });
    detectQueue(form.street, selectedHouse, form.city);
  };

  const handleCityChange = (city: string) => {
    updateForm({
      city,
      street: '',
      houseNumber: '',
      streetConfirmed: false,
      streetSuggestions: [],
      houseSuggestions: [],
      showStreetDropdown: false,
      showHouseDropdown: false,
      detectedQueueId: '',
      queueId: '',
    });
  };

  const resetForm = () => {
    setForm({ ...initialFormState });
  };

  const handleAdd = async () => {
    const { name, city, lookupMode, street, houseNumber, queueId } = form;
    if (!name.trim()) {
      toast({ title: 'Вкажіть назву локації', description: 'Оберіть одну з запропонованих або введіть свою.' });
      return;
    }
    if (lookupMode === 'queue' && !queueId) return;
    if (lookupMode === 'address' && !street) return;
    setIsSaving(true);
    try {
      const globalSettings = useStore.getState();
      const resp = await fetch('/api/user/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          city,
          lookupMode,
          street: lookupMode === 'address' ? street : '',
          houseNumber: lookupMode === 'address' ? houseNumber : '',
          queueId: queueId || '',
          isPrimary: locations.length === 0,
          notifyEnabled: globalSettings.notificationsEnabled,
          notifyBeforeOff: globalSettings.notifyBeforeOff,
          notifyBeforeOn: globalSettings.notifyBeforeOn,
          telegramNotify: globalSettings.telegramNotifications,
          _tabId: getTabId(),
        }),
      });
      if (resp.ok) {
        if (onboardingMode) {
          useStore.getState().setHasSeenOnboarding(true);
          navigate('/');
          return;
        }
        setShowAdd(false);
        resetForm();
        fetchLocations();
      } else {
        const err = await resp.json().catch(() => ({}));
        console.error('[LocationManager] Add failed:', resp.status, err);
        toast({ title: 'Помилка збереження', description: err.error || 'Спробуйте ще раз', variant: 'destructive' });
      }
    } catch (e: any) {
      console.error('[LocationManager] Add error:', e);
      toast({ title: 'Помилка збереження', description: 'Перевірте з\'єднання', variant: 'destructive' });
    }
    setIsSaving(false);
  };

  const handleDelete = async (id: number) => {
    if (locations.length <= 1) {
      toast({ title: 'Не можна видалити єдину локацію', description: 'Додайте іншу локацію перед видаленням або вимкніть сповіщення.', variant: 'destructive' });
      setDeleteConfirmId(null);
      return;
    }
    setIsDeleting(true);
    try {
      const resp = await fetch(`/api/user/locations/${id}`, { method: 'DELETE' });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (data.code === 'LAST_LOCATION') {
          toast({ title: 'Не можна видалити єдину локацію', description: 'Додайте іншу локацію перед видаленням або вимкніть сповіщення.', variant: 'destructive' });
          setDeleteConfirmId(null);
          return;
        }
      }
      setDeleteConfirmId(null);
      fetchLocations();
    } catch {} finally {
      setIsDeleting(false);
    }
  };

  const handleSetPrimary = async (id: number) => {
    const target = locations.find(l => l.id === id);
    if (!target) return;

    const newOrder = [target, ...locations.filter(l => l.id !== id)];
    setLocations(newOrder.map((l, i) => ({
      ...l,
      isPrimary: l.id === id,
      orderIndex: i,
    })));

    try {
      await fetch(`/api/user/locations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPrimary: true, orderIndex: 0, _tabId: getTabId() }),
      });
      const orderedIds = newOrder.map(l => l.id);
      await fetch('/api/user/locations-reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds, _tabId: getTabId() }),
      });
    } catch {
      fetchLocations();
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const draggedLoc = locations.find(l => l.id === active.id);
    const targetLoc = locations.find(l => l.id === over.id);
    if (draggedLoc?.isPrimary || targetLoc?.isPrimary) return;

    const oldIndex = locations.findIndex(l => l.id === active.id);
    const newIndex = locations.findIndex(l => l.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    if (newIndex === 0 && locations[0]?.isPrimary) return;

    const newLocations = arrayMove(locations, oldIndex, newIndex);
    setLocations(newLocations.map((l, i) => ({ ...l, orderIndex: i })));

    try {
      await fetch('/api/user/locations-reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: newLocations.map(l => l.id), _tabId: getTabId() }),
      });
    } catch {
      fetchLocations();
    }
  };

  const handleToggleNotify = async (id: number, field: 'notifyEnabled' | 'telegramNotify', value: boolean) => {
    if (value) {
      if (field === 'notifyEnabled' && !store.notificationsEnabled) {
        toast({
          title: 'Увімкніть глобальні Push-сповіщення',
          description: 'Спочатку увімкніть Push-сповіщення в розділі "Сповіщення" нижче.',
          duration: 4000,
        });
        return;
      }
      if (field === 'telegramNotify' && !store.telegramNotifications) {
        toast({
          title: 'Увімкніть Telegram-сповіщення',
          description: 'Спочатку увімкніть Telegram в розділі "Сповіщення" нижче та підключіть бота.',
          duration: 4000,
        });
        return;
      }
    }

    setLocations(prev => prev.map(loc =>
      loc.id === id ? { ...loc, [field]: value } : loc
    ));

    try {
      await fetch(`/api/user/locations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value, _tabId: getTabId() }),
      });
    } catch {
      setLocations(prev => prev.map(loc =>
        loc.id === id ? { ...loc, [field]: !value } : loc
      ));
    }
  };

  const startEdit = (loc: UserLocation) => {
    setEditId(loc.id);
    setForm({
      ...initialFormState,
      name: loc.name,
      city: loc.city,
      lookupMode: (loc.lookupMode as 'address' | 'queue') || 'queue',
      street: loc.street || '',
      houseNumber: loc.houseNumber || '',
      queueId: loc.queueId || '',
      streetConfirmed: !!loc.street,
      detectedQueueId: loc.queueId || '',
    });
  };

  const handleUpdate = async (id: number) => {
    const { name, city, lookupMode, street, houseNumber, queueId } = form;
    if (!name.trim()) {
      toast({ title: 'Вкажіть назву локації', description: 'Оберіть одну з запропонованих або введіть свою.' });
      return;
    }
    setIsSaving(true);
    try {
      await fetch(`/api/user/locations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          city,
          lookupMode,
          street: lookupMode === 'address' ? street : '',
          houseNumber: lookupMode === 'address' ? houseNumber : '',
          queueId: queueId || '',
          _tabId: getTabId(),
        }),
      });
      setEditId(null);
      resetForm();
      fetchLocations();
    } catch {}
    setIsSaving(false);
  };

  if (isLoading) {
    return (
      <div className={cn("rounded-[32px] backdrop-blur-xl transition-all duration-300 border",
        isLight ? "bg-white border-zinc-200 shadow-sm" : "bg-zinc-900/20 border-white/5"
      )}>
        <div className="p-5">
          <div className={cn("flex items-center gap-3 text-lg font-bold", isLight ? "text-zinc-800" : "text-white")}>
            {!onboardingMode && (
              <ChevronRight className="w-4 h-4" style={{ color: 'var(--accent-hex, #10b981)' }} />
            )}
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.1' : '0.12'})`,
              }}
            >
              <MapPin className="w-4 h-4" style={{ color: 'var(--accent-hex, #10b981)' }} />
            </div>
            {onboardingMode ? 'Додайте адресу' : 'Мої локації'}
          </div>
        </div>
      </div>
    );
  }

  const canSave = (() => {
    const { name, lookupMode, street, queueId } = form;
    if (!name.trim()) return false;
    if (lookupMode === 'queue' && !queueId) return false;
    if (lookupMode === 'address' && !street) return false;
    return true;
  })();

  const renderAddressForm = (isEdit: boolean, locId?: number) => {
    const inputCls = cn("h-11 rounded-xl text-sm", isLight ? "bg-white border-zinc-200 focus:border-zinc-400" : "bg-zinc-800 border-zinc-700 text-white focus:border-zinc-500");
    const dropdownCls = cn(
      "absolute left-0 right-0 top-full mt-1.5 z-[100] max-h-56 overflow-y-auto rounded-2xl border-2 shadow-2xl backdrop-blur-xl",
      isLight ? "bg-white/95 border-zinc-300 shadow-zinc-200/50" : "bg-zinc-800/95 border-zinc-600 shadow-black/40"
    );
    const dropdownItemCls = cn(
      "px-4 py-3 text-sm cursor-pointer transition-all first:rounded-t-xl last:rounded-b-xl",
      isLight ? "hover:bg-emerald-50 text-zinc-700 active:bg-emerald-100" : "hover:bg-zinc-700/80 text-zinc-200 active:bg-zinc-600/80"
    );

    return (
      <div className={cn("p-5 rounded-2xl border space-y-4",
        isLight ? "border-zinc-200 bg-zinc-50/80" : "border-white/10 bg-white/[0.03]"
      )}>
        <div className="flex flex-wrap gap-1.5">
          {PRESET_NAMES.map(({ label, icon: Icon }) => (
            <button
              key={label}
              onClick={() => updateForm({ name: label })}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all border",
                form.name === label
                  ? "border-transparent text-white"
                  : (isLight ? "border-zinc-200 hover:border-zinc-300 text-zinc-600" : "border-white/10 hover:border-white/20 text-zinc-400")
              )}
              style={form.name === label ? {
                background: 'var(--accent-hex, #10b981)',
                borderColor: 'var(--accent-hex, #10b981)',
              } : undefined}
              data-testid={`btn-preset-${label}`}
            >
              <Icon className="w-3 h-3" /> {label}
            </button>
          ))}
        </div>

        <Input
          placeholder="Або введіть свою назву..."
          value={form.name}
          onChange={e => updateForm({ name: e.target.value })}
          maxLength={100}
          className={inputCls}
          data-testid="input-location-name"
        />

        <div>
          <p className={cn("text-[10px] font-bold uppercase tracking-widest mb-2", isLight ? "text-zinc-500" : "text-zinc-500")}>Місто</p>
          <div className="flex gap-2">
            {CITIES.map(c => (
              <button
                key={c}
                onClick={() => handleCityChange(c)}
                className={cn(
                  "flex-1 h-10 rounded-xl font-bold text-sm transition-all border-2",
                  form.city === c
                    ? "text-white border-transparent"
                    : (isLight ? "bg-zinc-50 border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:border-zinc-300" : "bg-white/5 border-white/10 text-zinc-400 hover:bg-white/10 hover:border-white/20")
                )}
                style={form.city === c ? {
                  background: 'var(--accent-hex, #10b981)',
                  borderColor: 'var(--accent-hex, #10b981)',
                } : undefined}
                data-testid={`select-city-${c}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className={cn("flex rounded-xl p-1", isLight ? "bg-zinc-100" : "bg-zinc-800")}>
          <button
            className={cn(
              "flex-1 py-2 text-xs font-medium rounded-lg transition-all",
              form.lookupMode === 'address'
                ? (isLight ? "bg-white shadow-sm text-zinc-800 border border-zinc-200" : "bg-zinc-700 text-white border border-zinc-600")
                : (isLight ? "text-zinc-500 hover:text-zinc-700" : "text-zinc-500 hover:text-zinc-300")
            )}
            onClick={() => updateForm({ lookupMode: 'address', queueId: '', detectedQueueId: '' })}
            data-testid="btn-mode-address"
          >
            <Search className="w-3 h-3 inline mr-1" />
            За адресою
          </button>
          <button
            className={cn(
              "flex-1 py-2 text-xs font-medium rounded-lg transition-all",
              form.lookupMode === 'queue'
                ? (isLight ? "bg-white shadow-sm text-zinc-800 border border-zinc-200" : "bg-zinc-700 text-white border border-zinc-600")
                : (isLight ? "text-zinc-500 hover:text-zinc-700" : "text-zinc-500 hover:text-zinc-300")
            )}
            onClick={() => updateForm({ lookupMode: 'queue', street: '', houseNumber: '', streetConfirmed: false, detectedQueueId: '' })}
            data-testid="btn-mode-queue"
          >
            <MapPin className="w-3 h-3 inline mr-1" />
            За чергою
          </button>
        </div>

        {form.lookupMode === 'address' && (
          <div className="space-y-3">
            <div ref={streetContainerRef} className="relative">
              <div className="relative">
                <Input
                  placeholder="Введіть вулицю..."
                  value={form.street}
                  onChange={e => handleStreetInput(e.target.value)}
                  onFocus={() => {
                    if (form.streetSuggestions.length > 0) updateForm({ showStreetDropdown: true });
                  }}
                  className={inputCls}
                  data-testid="input-location-street"
                />
                {form.isSearchingStreet && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                  </div>
                )}
                {form.streetConfirmed && !form.isSearchingStreet && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Check className="w-4 h-4" style={{ color: 'var(--accent-hex, #10b981)' }} />
                  </div>
                )}
              </div>
              {form.showStreetDropdown && form.streetSuggestions.length > 0 && (
                <div className={dropdownCls} data-testid="dropdown-streets">
                  {form.streetSuggestions.map((s, i) => (
                    <div
                      key={i}
                      className={dropdownItemCls}
                      onClick={() => handleStreetSelect(s)}
                      data-testid={`street-option-${i}`}
                    >
                      {s}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {form.streetConfirmed && (
              <div ref={houseContainerRef} className="relative">
                <div className="relative">
                  <Input
                    placeholder="Номер будинку..."
                    value={form.houseNumber}
                    onChange={e => handleHouseInput(e.target.value)}
                    onFocus={() => {
                      if (form.houseSuggestions.length > 0) updateForm({ showHouseDropdown: true });
                      else if (form.streetConfirmed && form.street) {
                        searchHouseNumbers(form.street, '', form.city);
                      }
                    }}
                    className={inputCls}
                    data-testid="input-location-house"
                  />
                  {form.isSearchingHouse && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                    </div>
                  )}
                </div>
                {form.showHouseDropdown && form.houseSuggestions.length > 0 && (
                  <div className={dropdownCls} data-testid="dropdown-houses">
                    {form.houseSuggestions.map((h, i) => (
                      <div
                        key={i}
                        className={dropdownItemCls}
                        onClick={() => handleHouseSelect(h)}
                        data-testid={`house-option-${i}`}
                      >
                        {h}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {form.isDetectingQueue && (
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                Визначення черги...
              </div>
            )}

            {form.detectedQueueId && !form.isDetectingQueue && (
              <div className={cn("flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl")}
                style={{
                  background: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.08' : '0.1'})`,
                  color: 'var(--accent-hex, #10b981)',
                }}
              >
                <Check className="w-3 h-3" />
                Черга: {form.detectedQueueId}
              </div>
            )}

            {form.streetConfirmed && !form.isDetectingQueue && !form.detectedQueueId && (
              <div className="space-y-2">
                {form.needsManualQueue ? (
                  <div className={cn("flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl",
                    isLight ? "bg-blue-50 text-blue-700 border border-blue-200" : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                  )}>
                    <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>Оберіть вашу чергу. Дізнатися номер черги можна на сайті вашого оператора або у квитанції за електроенергію.</span>
                  </div>
                ) : (
                  <div className={cn("flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl",
                    isLight ? "bg-amber-50 text-amber-700 border border-amber-200" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  )}>
                    <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>Графіків для цієї адреси поки немає. Збережіть — коли з'являться, ми повідомимо.</span>
                  </div>
                )}
                {!form.needsManualQueue && !form.queueId && (
                  <button
                    onClick={() => updateForm({ showManualQueue: !form.showManualQueue })}
                    className={cn("text-xs flex items-center gap-1 transition-colors",
                      isLight ? "text-zinc-400 hover:text-zinc-600" : "text-zinc-500 hover:text-zinc-300"
                    )}
                    data-testid="btn-show-manual-queue"
                  >
                    <ChevronDown className={cn("w-3 h-3 transition-transform", form.showManualQueue && "rotate-180")} />
                    Або обрати чергу вручну
                  </button>
                )}
                {(form.showManualQueue || form.queueId) && (
                  <div className="flex flex-wrap gap-1.5">
                    {queues.map(q => (
                      <button
                        key={q}
                        onClick={() => updateForm({ queueId: q })}
                        className={cn(
                          "px-3 py-1.5 text-xs font-bold rounded-lg border transition-all",
                          form.queueId === q
                            ? "text-white border-transparent"
                            : (isLight ? "border-zinc-200 text-zinc-600 hover:border-zinc-300" : "border-white/10 text-zinc-400 hover:border-white/20")
                        )}
                        style={form.queueId === q ? {
                          background: 'var(--accent-hex, #10b981)',
                          borderColor: 'var(--accent-hex, #10b981)',
                        } : undefined}
                        data-testid={`select-location-queue-${q}`}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {form.lookupMode === 'queue' && (
          <div className="space-y-1.5">
            <p className={cn("text-xs", isLight ? "text-zinc-500" : "text-zinc-500")}>
              Оберіть чергу:
            </p>
            <div className="flex flex-wrap gap-1.5 max-h-[200px] overflow-y-auto">
              {queues.map(q => (
                <button
                  key={q}
                  onClick={() => updateForm({ queueId: q })}
                  className={cn(
                    "px-3 py-1.5 text-xs font-bold rounded-lg border transition-all",
                    form.queueId === q
                      ? "text-white border-transparent"
                      : (isLight ? "border-zinc-200 text-zinc-600 hover:border-zinc-300" : "border-white/10 text-zinc-400 hover:border-white/20")
                  )}
                  style={form.queueId === q ? {
                    background: 'var(--accent-hex, #10b981)',
                    borderColor: 'var(--accent-hex, #10b981)',
                  } : undefined}
                  data-testid={`select-location-queue-${q}`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={() => {
              if (isEdit) { setEditId(null); } else {
                if (onboardingMode) return;
                setShowAdd(false);
              }
              resetForm();
            }}
            className={cn(
              "flex-1 h-11 text-sm font-medium rounded-2xl border transition-colors",
              onboardingMode && !isEdit && "hidden",
              isLight
                ? "border-zinc-200 text-zinc-600 bg-zinc-50 hover:bg-zinc-100 hover:border-zinc-300 active:bg-zinc-150"
                : "border-white/10 text-zinc-400 bg-white/[0.04] hover:bg-white/[0.08] hover:border-white/15 active:bg-white/[0.12]"
            )}
            data-testid="btn-cancel-location"
          >
            Скасувати
          </button>
          <button
            onClick={() => {
              if (!form.name.trim()) {
                toast({ title: 'Вкажіть назву локації', description: 'Оберіть одну з запропонованих або введіть свою.' });
                return;
              }
              isEdit && locId ? handleUpdate(locId) : handleAdd();
            }}
            disabled={isSaving}
            className={cn(
              "flex-1 h-11 text-sm font-semibold rounded-2xl border transition-colors flex items-center justify-center gap-1.5",
              canSave
                ? "text-white hover:opacity-90 active:opacity-80 border-transparent"
                : isLight
                  ? "bg-zinc-100 text-zinc-400 border-zinc-200"
                  : "bg-white/[0.04] text-zinc-600 border-white/5"
            )}
            style={canSave ? {
              backgroundColor: 'var(--accent-hex, #10b981)',
              background: `color-mix(in srgb, var(--accent-hex, #10b981) 85%, black 15%)`,
            } : undefined}
            data-testid="btn-save-location"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {isEdit ? 'Зберегти' : onboardingMode ? 'Почати' : 'Додати'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={cn("rounded-[32px] backdrop-blur-xl transition-all duration-300 border",
      isLight ? "bg-white border-zinc-200 shadow-sm hover:border-zinc-400 hover:shadow-md" : "bg-zinc-900/20 border-white/5 hover:border-white/15"
    )}>
      <div
        className={cn("p-5", !onboardingMode && "cursor-pointer select-none", sectionCollapsed && !onboardingMode ? "pb-5" : "pb-3")}
        onClick={() => { if (!onboardingMode) setSectionCollapsed(prev => !prev); }}
        data-testid="btn-toggle-locations-section"
      >
        <div className={cn("flex items-center gap-3 text-lg font-bold", isLight ? "text-zinc-800" : "text-white")}>
          {!onboardingMode && (
            <motion.div
              animate={{ rotate: sectionCollapsed ? 0 : 90 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronRight className="w-4 h-4" style={{ color: 'var(--accent-hex, #10b981)' }} />
            </motion.div>
          )}
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.1' : '0.12'})`,
            }}
          >
            <MapPin className="w-4 h-4" style={{ color: 'var(--accent-hex, #10b981)' }} />
          </div>
          {onboardingMode ? 'Додайте адресу' : `Мої локації (${locations.length}/5)`}
        </div>
        {!sectionCollapsed && (
          <p className={cn("text-xs mt-1", !onboardingMode && "ml-11", isLight ? "text-zinc-500" : "text-zinc-500")}>
            {onboardingMode ? 'Оберіть місто та введіть адресу або номер черги' : 'Відстежуйте графіки для кількох адрес одночасно'}
          </p>
        )}
      </div>
      <AnimatePresence initial={false}>
      {!sectionCollapsed && (
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } }}
        exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      >
      <div className="px-5 pb-5">
        <motion.div
          className="space-y-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          {locations.length > 1 && !onboardingMode && (
            <AnimatePresence>
              {showReorderHint && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-xl text-[11px]",
                    isLight ? "bg-amber-50 text-amber-700" : "bg-amber-500/10 text-amber-400"
                  )}
                >
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  <span>Утримуйте <GripVertical className="w-3 h-3 inline -mt-0.5" /> щоб перетягнути локацію та змінити порядок</span>
                  <button
                    onClick={() => setShowReorderHint(false)}
                    className="ml-auto shrink-0 p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-500/20"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          )}

          <LayoutGroup>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={locations.map(l => l.id)}
              strategy={verticalListSortingStrategy}
            >
              {locations.map((loc, idx) => (
                <SortableLocationCard
                  key={loc.id}
                  loc={loc}
                  idx={idx}
                  isLight={isLight}
                  isExpanded={expandedId === loc.id}
                  isEditing={editId === loc.id}
                  locationsCount={locations.length}
                  onToggleExpand={() => setExpandedId(expandedId === loc.id ? null : loc.id)}
                  onSetPrimary={() => handleSetPrimary(loc.id)}
                  onStartEdit={() => startEdit(loc)}
                  onRequestDelete={() => {
                    if (locations.length <= 1) {
                      toast({ title: 'Не можна видалити єдину локацію', description: 'Додайте іншу локацію перед видаленням або вимкніть сповіщення.' });
                      return;
                    }
                    setDeleteConfirmId(loc.id);
                  }}
                  onConfirmDelete={() => handleDelete(loc.id)}
                  onCancelDelete={() => setDeleteConfirmId(null)}
                  isDeleteConfirming={deleteConfirmId === loc.id}
                  isDeleting={isDeleting}
                  onToggleNotify={(field, value) => handleToggleNotify(loc.id, field, value)}
                  renderEditForm={() => renderAddressForm(true, loc.id)}
                  onShowReorderHint={() => {
                    if (!showReorderHint) setShowReorderHint(true);
                  }}
                />
              ))}
            </SortableContext>
          </DndContext>
          </LayoutGroup>

          <AnimatePresence>
            {showAdd && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
              >
                {renderAddressForm(false)}
              </motion.div>
            )}
          </AnimatePresence>

          {!showAdd && editId === null && locations.length < 5 && !onboardingMode && (
            <motion.button
              onClick={() => { resetForm(); setShowAdd(true); }}
              data-testid="btn-add-location"
              whileHover={{ scale: 1.015, boxShadow: `0 0 20px rgba(var(--accent-hex-rgb, 16,185,129), 0.2)` }}
              whileTap={{ scale: 0.97 }}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl border-2 border-dashed text-sm font-bold transition-all duration-200"
              )}
              style={{
                borderColor: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.3' : '0.2'})`,
                color: 'var(--accent-hex, #10b981)',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.05' : '0.05'})`;
                e.currentTarget.style.borderColor = `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.5' : '0.4'})`;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.borderColor = `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.3' : '0.2'})`;
              }}
            >
              <Plus className="w-4 h-4" />
              Додати локацію
            </motion.button>
          )}
        </motion.div>
      </div>
      </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}

interface SortableLocationCardProps {
  loc: UserLocation;
  idx: number;
  isLight: boolean;
  isExpanded: boolean;
  isEditing: boolean;
  locationsCount: number;
  onToggleExpand: () => void;
  onSetPrimary: () => void;
  onStartEdit: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  isDeleteConfirming: boolean;
  isDeleting: boolean;
  onToggleNotify: (field: 'notifyEnabled' | 'telegramNotify', value: boolean) => void;
  renderEditForm: () => React.ReactNode;
  onShowReorderHint: () => void;
}

function SortableLocationCard({
  loc, idx, isLight, isExpanded, isEditing, locationsCount,
  onToggleExpand, onSetPrimary, onStartEdit, onRequestDelete, onConfirmDelete, onCancelDelete, isDeleteConfirming, isDeleting, onToggleNotify, renderEditForm, onShowReorderHint,
}: SortableLocationCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: loc.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  const emoji = getLocationEmoji(loc.name);
  const isOpen = isExpanded || isEditing;

  return (
    <motion.div
      ref={setNodeRef}
      layout
      layoutId={`location-card-${loc.id}`}
      style={{
        ...style,
        ...(loc.isPrimary ? {
          borderColor: isOpen
            ? `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.6' : '0.5'})`
            : `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.4' : '0.3'})`,
          background: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.03' : '0.03'})`,
        } : {
          background: isLight ? 'rgba(250,250,250,0.8)' : 'rgba(255,255,255,0.02)',
        }),
      }}
      initial={false}
      animate={{
        opacity: isDragging ? 0.85 : 1,
        scale: isDragging ? 1.02 : 1,
        boxShadow: isOpen
          ? `0 0 20px rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.15' : '0.12'}), 0 4px 16px rgba(0,0,0,${isLight ? '0.06' : '0.2'})`
          : isDragging
            ? '0 20px 40px rgba(0,0,0,0.15)'
            : '0 0 0px rgba(0,0,0,0)',
      }}
      transition={{ layout: { duration: 0.4, ease: [0.4, 0, 0.2, 1] }, duration: 0.3 }}
      whileHover={!isEditing && !isDragging ? {
        boxShadow: `0 0 24px rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.18' : '0.15'}), 0 4px 20px rgba(0,0,0,${isLight ? '0.06' : '0.2'})`,
        borderColor: loc.isPrimary
          ? `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.6' : '0.5'})`
          : `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.35' : '0.25'})`,
      } : undefined}
      className={cn(
        "rounded-2xl border transition-all duration-300 group/card relative",
        loc.isPrimary ? "border-2" : (isLight ? "border-zinc-200" : "border-white/5"),
        !isEditing && "cursor-pointer",
        isOpen && !loc.isPrimary && (isLight ? "border-zinc-300" : "border-white/10"),
      )}
      data-testid={`location-card-${loc.id}`}
      onClick={() => {
        if (!isEditing && !isDragging) onToggleExpand();
      }}
    >
      {!isOpen && !isEditing && (
        <div
          className="absolute bottom-0 left-0 right-0 h-[2px] transition-all duration-300 opacity-0 group-hover/card:opacity-100"
          style={{
            background: `linear-gradient(90deg, transparent, rgba(var(--accent-hex-rgb, 16,185,129), 0.5), transparent)`,
          }}
        />
      )}

      {isEditing ? (
        <div className="p-3.5" onClick={e => e.stopPropagation()}>
          {renderEditForm()}
        </div>
      ) : (
        <>
          <div className="p-3.5 select-none">
            <div className="flex items-center gap-2.5">
              {locationsCount > 1 && !loc.isPrimary && (
                <div
                  {...attributes}
                  {...listeners}
                  onClick={e => e.stopPropagation()}
                  className={cn(
                    "shrink-0 cursor-grab active:cursor-grabbing p-1.5 rounded-lg touch-none transition-colors",
                    isLight ? "text-zinc-300 hover:text-zinc-500 hover:bg-zinc-100" : "text-zinc-600 hover:text-zinc-400 hover:bg-white/5"
                  )}
                  onPointerDown={(e) => {
                    onShowReorderHint();
                    listeners?.onPointerDown?.(e);
                  }}
                  data-testid={`drag-handle-${loc.id}`}
                >
                  <GripVertical className="w-4 h-4" />
                </div>
              )}

              <div
                className={cn(
                  "shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-base",
                  isLight ? "bg-zinc-100" : "bg-white/5"
                )}
                style={loc.isPrimary ? {
                  background: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.1' : '0.12'})`,
                } : undefined}
              >
                {emoji}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={cn("text-sm font-bold truncate", isLight ? "text-zinc-800" : "text-white")}>
                    {loc.name}
                  </span>
                  {loc.isPrimary && (
                    <span
                      className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                      style={{
                        color: 'var(--accent-hex, #10b981)',
                        background: `rgba(var(--accent-hex-rgb, 16,185,129), ${isLight ? '0.12' : '0.15'})`,
                      }}
                      data-testid={`badge-primary-${loc.id}`}
                    >
                      На головній
                    </span>
                  )}
                  {!isOpen && (
                    <div className="flex items-center gap-1 shrink-0 ml-auto">
                      <Bell className={cn("w-3.5 h-3.5", loc.notifyEnabled ? "text-emerald-500" : (isLight ? "text-zinc-300" : "text-zinc-700"))} />
                      <MessageCircle className={cn("w-3.5 h-3.5", loc.telegramNotify ? "text-sky-500" : (isLight ? "text-zinc-300" : "text-zinc-700"))} />
                    </div>
                  )}
                </div>
                <span className={cn("text-xs mt-0.5 block truncate", isLight ? "text-zinc-400" : "text-zinc-500")}>
                  {loc.city}
                  {loc.street ? `, ${loc.street}` : ''}
                  {loc.houseNumber ? `, ${loc.houseNumber}` : ''}
                  {loc.queueId ? ` • Черга ${loc.queueId}` : ''}
                  {!loc.street && !loc.queueId && ' • —'}
                </span>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <motion.div
                  className={cn(
                    "p-2 rounded-xl transition-all duration-300",
                    isOpen
                      ? ""
                      : (isLight ? "text-zinc-300 group-hover/card:text-zinc-500" : "text-zinc-600 group-hover/card:text-zinc-400")
                  )}
                  style={isOpen ? { color: 'var(--accent-hex, #10b981)' } : undefined}
                  data-testid={`btn-expand-${loc.id}`}
                >
                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                  >
                    <ChevronDown className="w-4 h-4" />
                  </motion.div>
                </motion.div>
              </div>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {isDeleteConfirming && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                <div className={cn("mx-3.5 mb-3 p-3 rounded-xl border", isLight ? "bg-red-50 border-red-200" : "bg-red-500/10 border-red-500/20")}>
                  <div className="flex items-center gap-2 mb-2.5">
                    <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                    <span className={cn("text-sm font-medium", isLight ? "text-red-700" : "text-red-400")}>
                      Видалити "{loc.name}"?
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={onCancelDelete}
                      className={cn(
                        "flex-1 h-10 rounded-xl text-sm font-medium transition-colors",
                        isLight ? "bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50" : "bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700"
                      )}
                      data-testid={`btn-cancel-delete-${loc.id}`}
                    >
                      Скасувати
                    </button>
                    <button
                      onClick={onConfirmDelete}
                      disabled={isDeleting}
                      className={cn("flex-1 h-10 rounded-xl text-sm font-medium bg-red-500 text-white transition-colors", isDeleting ? "opacity-60 cursor-not-allowed" : "hover:bg-red-600")}
                      data-testid={`btn-confirm-delete-${loc.id}`}
                    >
                      {isDeleting ? 'Видалення...' : 'Видалити'}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {isOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                <div className={cn("px-3.5 pb-3.5 pt-0")}>
                  <div className={cn("border-t pt-2.5 space-y-2", isLight ? "border-zinc-100" : "border-white/5")}>
                    <div className={cn("text-xs font-medium mb-1.5 px-1", isLight ? "text-zinc-500" : "text-zinc-500")}>
                      Сповіщення
                    </div>
                    <motion.div
                      className={cn(
                        "flex items-center justify-between rounded-xl px-3.5 py-2.5 transition-colors",
                        loc.notifyEnabled
                          ? (isLight ? "bg-emerald-50/70" : "bg-emerald-500/[0.06]")
                          : "bg-transparent"
                      )}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="flex items-center gap-2.5">
                        <motion.div
                          animate={loc.notifyEnabled ? { scale: [1, 1.2, 1] } : { scale: 1 }}
                          transition={{ duration: 0.3 }}
                        >
                          <Bell className={cn("w-4 h-4 transition-colors", loc.notifyEnabled ? "text-emerald-500" : (isLight ? "text-zinc-400" : "text-zinc-500"))} />
                        </motion.div>
                        <span className={cn("text-sm transition-colors", loc.notifyEnabled ? (isLight ? "text-zinc-700" : "text-zinc-300") : (isLight ? "text-zinc-500" : "text-zinc-500"))}>Push-сповіщення</span>
                      </div>
                      <Switch
                        checked={loc.notifyEnabled}
                        onCheckedChange={v => onToggleNotify('notifyEnabled', v)}
                        className={cn("transition-shadow data-[state=checked]:bg-emerald-500 data-[state=checked]:shadow-[0_0_8px_rgba(16,185,129,0.4)]", isLight ? "data-[state=unchecked]:bg-zinc-300 data-[state=unchecked]:border data-[state=unchecked]:border-zinc-400" : "data-[state=unchecked]:bg-zinc-600")}
                        data-testid={`switch-push-${loc.id}`}
                      />
                    </motion.div>
                    <motion.div
                      className={cn(
                        "flex items-center justify-between rounded-xl px-3.5 py-2.5 transition-colors",
                        loc.telegramNotify
                          ? (isLight ? "bg-sky-50/70" : "bg-sky-500/[0.06]")
                          : "bg-transparent"
                      )}
                      whileTap={{ scale: 0.98 }}
                    >
                      <div className="flex items-center gap-2.5">
                        <motion.div
                          animate={loc.telegramNotify ? { scale: [1, 1.2, 1] } : { scale: 1 }}
                          transition={{ duration: 0.3 }}
                        >
                          <MessageCircle className={cn("w-4 h-4 transition-colors", loc.telegramNotify ? "text-sky-500" : (isLight ? "text-zinc-400" : "text-zinc-500"))} />
                        </motion.div>
                        <span className={cn("text-sm transition-colors", loc.telegramNotify ? (isLight ? "text-zinc-700" : "text-zinc-300") : (isLight ? "text-zinc-500" : "text-zinc-500"))}>Telegram-сповіщення</span>
                      </div>
                      <Switch
                        checked={loc.telegramNotify}
                        onCheckedChange={v => onToggleNotify('telegramNotify', v)}
                        className={cn("transition-shadow data-[state=checked]:bg-sky-500 data-[state=checked]:shadow-[0_0_8px_rgba(56,189,248,0.4)]", isLight ? "data-[state=unchecked]:bg-zinc-300 data-[state=unchecked]:border data-[state=unchecked]:border-zinc-400" : "data-[state=unchecked]:bg-zinc-600")}
                        data-testid={`switch-telegram-${loc.id}`}
                      />
                    </motion.div>

                    <div className={cn("border-t pt-2.5 mt-2.5 flex flex-wrap items-center gap-2", isLight ? "border-zinc-100" : "border-white/5")}>
                      {!loc.isPrimary && locationsCount > 1 && (
                        <button
                          onClick={onSetPrimary}
                          className={cn(
                            "flex items-center justify-center gap-1.5 h-11 px-3.5 rounded-xl transition-all border text-sm font-medium",
                            isLight ? "border-zinc-200 text-zinc-500 hover:border-amber-300 hover:text-amber-600 hover:bg-amber-50 active:bg-amber-100" : "border-zinc-700 text-zinc-400 hover:border-amber-500/40 hover:text-amber-400 hover:bg-amber-500/10 active:bg-amber-500/20"
                          )}
                          data-testid={`btn-primary-${loc.id}`}
                        >
                          <Star className="w-4 h-4" />
                          На головну
                        </button>
                      )}
                      <button
                        onClick={onStartEdit}
                        className={cn(
                          "flex items-center justify-center gap-1.5 h-11 px-3.5 rounded-xl transition-all border text-sm font-medium",
                          isLight ? "border-zinc-200 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 hover:border-zinc-300 active:bg-zinc-100" : "border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 hover:border-zinc-600 active:bg-white/10"
                        )}
                        data-testid={`btn-edit-${loc.id}`}
                      >
                        <Edit2 className="w-4 h-4" />
                        Змінити
                      </button>
                      <button
                        onClick={onRequestDelete}
                        className={cn(
                          "flex items-center justify-center gap-1.5 h-11 px-3.5 rounded-xl transition-all border ml-auto text-sm font-medium",
                          isLight ? "border-red-200 text-red-400 hover:text-red-600 hover:bg-red-50 hover:border-red-300 active:bg-red-100" : "border-red-500/20 text-red-500/60 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30 active:bg-red-500/20"
                        )}
                        data-testid={`btn-delete-${loc.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                        Видалити
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </motion.div>
  );
}
