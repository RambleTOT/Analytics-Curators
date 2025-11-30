import React, { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { clsx } from "clsx";

type PostRecord = {
  id: number;
  date: string;
  dateObj: Date;
  monthKey: string; // YYYY-MM
  weekdayIndex: number; // 0-6
  weekdayLabel: string; // Вс, Пн...
  hour: number; // 0-23
  views: number;
  reactions: number;
  er: number; // 0–1
  postType: string;
};

const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

// Бакеты пауз между постами (в часах)
const GAP_BUCKETS = [
  { id: "<6", label: "< 6 часов", min: 0, max: 6 },
  { id: "6-12", label: "6–12 часов", min: 6, max: 12 },
  { id: "12-24", label: "12–24 часа", min: 12, max: 24 },
  { id: "24-48", label: "24–48 часов", min: 24, max: 48 },
  { id: ">48", label: "> 48 часов", min: 48, max: Infinity },
];

// Сегменты времени суток
const TIME_SEGMENTS = [
  { id: "night", label: "00–06 (ночь)", minHour: 0, maxHour: 6 },
  { id: "morning", label: "06–10 (утро)", minHour: 6, maxHour: 10 },
  { id: "day", label: "10–17 (день)", minHour: 10, maxHour: 17 },
  { id: "evening", label: "17–22 (вечер)", minHour: 17, maxHour: 22 },
  { id: "late", label: "22–24 (поздний вечер)", minHour: 22, maxHour: 24 },
];

/** Парсинг даты из Excel/CSV */
function parseDate(value: any): Date | null {
  if (!value) return null;

  // Серийная дата Excel (число)
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value) as any;
    if (!parsed) return null;
    return new Date(
      parsed.y,
      (parsed.m || 1) - 1,
      parsed.d || 1,
      parsed.H || 0,
      parsed.M || 0,
      parsed.S || 0
    );
  }

  // Если уже Date
  if (value instanceof Date) {
    return value;
  }

  // Строка
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Маппинг строки Excel → внутренняя структура
 *
 * Ожидаемые названия колонок:
 * - "Дата"
 * - "Время поста"
 * - "Количество просмотров в день поста"
 * - "Количество просмотров общее" (как запасной вариант)
 * - "Количество реакций"
 * - "Тип поста"
 * - "ER (Engagement Rate)" — в процентах
 */
function mapRowToPost(row: any, index: number): PostRecord | null {
  const rawDate = row["Дата"];
  const rawTime = row["Время поста"]; // строка "14:32:00" или excel-time число

  const viewsRaw =
    row["Количество просмотров в день поста"] ??
    row["Количество просмотров общее"];

  const reactionsRaw = row["Количество реакций"];
  const postTypeRaw = row["Тип поста"] ?? "Без типа";
  const erRaw = row["ER (Engagement Rate)"]; // в процентах

  const dateObj = parseDate(rawDate);
  if (!dateObj) return null;

  // Добавляем время поста к дате
  if (rawTime) {
    try {
      if (typeof rawTime === "number") {
        // Excel-формат времени: дробь от 0 до 1
        const totalMinutes = Math.round(rawTime * 24 * 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        dateObj.setHours(hours, minutes, 0, 0);
      } else {
        const timeStr = String(rawTime).trim(); // "14:32:00"
        const [hStr, mStr = "0", sStr = "0"] = timeStr.split(":");
        const h = Number(hStr) || 0;
        const m = Number(mStr) || 0;
        const s = Number(sStr) || 0;
        dateObj.setHours(h, m, s, 0);
      }
    } catch {
      console.warn("Не удалось разобрать время:", rawTime);
    }
  }

  const views = Number(viewsRaw) || 0;
  const reactions = Number(reactionsRaw) || 0;

  // ER из файла (в процентах) → доля 0–1
  let er: number;
  if (erRaw !== undefined && erRaw !== null && erRaw !== "") {
    const erNum = Number(erRaw);
    er = isFinite(erNum) ? erNum / 100 : 0;
  } else {
    er = views > 0 ? reactions / views : 0;
  }

  const year = dateObj.getFullYear();
  const month = dateObj.getMonth() + 1;
  const monthKey = `${year}-${month.toString().padStart(2, "0")}`;
  const weekdayIndex = dateObj.getDay();
  const weekdayLabel = WEEKDAYS[weekdayIndex];
  const hour = dateObj.getHours();

  return {
    id: index,
    date:
      typeof rawDate === "string"
        ? rawDate
        : dateObj.toISOString(),
    dateObj,
    monthKey,
    weekdayIndex,
    weekdayLabel,
    hour,
    views,
    reactions,
    er,
    postType: String(postTypeRaw ?? "Без типа"),
  };
}

function formatDateLabel(d: Date): string {
  const dd = d.getDate().toString().padStart(2, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${dd}.${mm}`;
}

const App: React.FC = () => {
  const [posts, setPosts] = useState<PostRecord[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [selectedPostType, setSelectedPostType] = useState<string>("all");
  const [selectedWeekday, setSelectedWeekday] = useState<string>("all");

  /** Загрузка файла */
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = evt.target?.result;
      if (!data) return;

      const workbook = XLSX.read(data, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const parsed: PostRecord[] = [];
      json.forEach((row, idx) => {
        const mapped = mapRowToPost(row, idx);
        if (mapped) parsed.push(mapped);
      });

      parsed.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
      setPosts(parsed);
      setSelectedMonth("all");
      setSelectedPostType("all");
      setSelectedWeekday("all");
    };

    reader.readAsArrayBuffer(file);
  };

  /** Список месяцев и типов постов */
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    posts.forEach((p) => set.add(p.monthKey));
    return Array.from(set).sort();
  }, [posts]);

  const postTypeOptions = useMemo(() => {
    const set = new Set<string>();
    posts.forEach((p) => set.add(p.postType));
    return Array.from(set).sort();
  }, [posts]);

  /** Фильтрация */
  const filteredPosts = useMemo(() => {
    return posts.filter((p) => {
      if (selectedMonth !== "all" && p.monthKey !== selectedMonth) return false;
      if (selectedPostType !== "all" && p.postType !== selectedPostType) return false;
      if (selectedWeekday !== "all" && p.weekdayLabel !== selectedWeekday) return false;
      return true;
    });
  }, [posts, selectedMonth, selectedPostType, selectedWeekday]);

  /** KPI по выборке */
  const kpi = useMemo(() => {
    if (filteredPosts.length === 0) {
      return {
        totalPosts: 0,
        avgViews: 0,
        avgReactions: 0,
        avgEr: 0,
      };
    }
    const totalPosts = filteredPosts.length;
    const sumViews = filteredPosts.reduce((acc, p) => acc + p.views, 0);
    const sumReactions = filteredPosts.reduce((acc, p) => acc + p.reactions, 0);
    const avgViews = sumViews / totalPosts;
    const avgReactions = sumReactions / totalPosts;
    const avgEr = filteredPosts.reduce((acc, p) => acc + p.er, 0) / totalPosts;

    return {
      totalPosts,
      avgViews,
      avgReactions,
      avgEr,
    };
  }, [filteredPosts]);

  /** Таймсерии для ER, просмотров, реакций */
  const timeSeriesData = useMemo(() => {
    return filteredPosts.map((p) => ({
      dateLabel: formatDateLabel(p.dateObj),
      views: p.views,
      reactions: p.reactions,
      erPercent: p.er * 100,
    }));
  }, [filteredPosts]);

  /** Средние просмотры по дням недели */
  const viewsByWeekday = useMemo(() => {
    const map = new Map<number, { weekday: string; viewsSum: number; count: number }>();
    filteredPosts.forEach((p) => {
      if (!map.has(p.weekdayIndex)) {
        map.set(p.weekdayIndex, {
          weekday: p.weekdayLabel,
          viewsSum: 0,
          count: 0,
        });
      }
      const entry = map.get(p.weekdayIndex)!;
      entry.viewsSum += p.views;
      entry.count += 1;
    });

    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([weekdayIndex, { weekday, viewsSum, count }]) => ({
        weekday,
        avgViews: count > 0 ? viewsSum / count : 0,
      }));
  }, [filteredPosts]);

  /** Средний ER по дням недели */
  const erByWeekday = useMemo(() => {
    const map = new Map<number, { weekday: string; erSum: number; count: number }>();
    filteredPosts.forEach((p) => {
      if (!map.has(p.weekdayIndex)) {
        map.set(p.weekdayIndex, {
          weekday: p.weekdayLabel,
          erSum: 0,
          count: 0,
        });
      }
      const entry = map.get(p.weekdayIndex)!;
      entry.erSum += p.er;
      entry.count += 1;
    });

    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([weekdayIndex, { weekday, erSum, count }]) => ({
        weekday,
        avgErPercent: count > 0 ? (erSum / count) * 100 : 0,
      }));
  }, [filteredPosts]);

  /** Зависимость от паузы с прошлого поста */
  const gapStats = useMemo(() => {
    if (filteredPosts.length < 2) return [];

    const sorted = [...filteredPosts].sort(
      (a, b) => a.dateObj.getTime() - b.dateObj.getTime()
    );

    type BucketAgg = {
      label: string;
      viewsSum: number;
      erSum: number;
      count: number;
    };

    const map = new Map<string, BucketAgg>();
    GAP_BUCKETS.forEach((b) =>
      map.set(b.id, { label: b.label, viewsSum: 0, erSum: 0, count: 0 })
    );

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const diffMs = cur.dateObj.getTime() - prev.dateObj.getTime();
      const gapHours = diffMs / (1000 * 60 * 60);

      const bucket =
        GAP_BUCKETS.find(
          (b) => gapHours >= b.min && gapHours < b.max
        ) ?? GAP_BUCKETS[GAP_BUCKETS.length - 1];

      const agg = map.get(bucket.id)!;
      agg.viewsSum += cur.views;
      agg.erSum += cur.er;
      agg.count += 1;
    }

    return GAP_BUCKETS.map((b) => {
      const agg = map.get(b.id)!;
      return {
        bucketId: b.id,
        bucketLabel: b.label,
        avgViews: agg.count ? agg.viewsSum / agg.count : 0,
        avgErPercent: agg.count ? (agg.erSum / agg.count) * 100 : 0,
      };
    });
  }, [filteredPosts]);

  /** Просмотры и ER по времени суток */
  const timeOfDayStats = useMemo(() => {
    if (filteredPosts.length === 0) return [];

    type SegmentAgg = {
      label: string;
      viewsSum: number;
      erSum: number;
      count: number;
    };

    const map = new Map<string, SegmentAgg>();
    TIME_SEGMENTS.forEach((s) =>
      map.set(s.id, {
        label: s.label,
        viewsSum: 0,
        erSum: 0,
        count: 0,
      })
    );

    filteredPosts.forEach((p) => {
      const seg =
        TIME_SEGMENTS.find(
          (s) => p.hour >= s.minHour && p.hour < s.maxHour
        ) ?? TIME_SEGMENTS[0];

      const agg = map.get(seg.id)!;
      agg.viewsSum += p.views;
      agg.erSum += p.er;
      agg.count += 1;
    });

    return TIME_SEGMENTS.map((s) => {
      const agg = map.get(s.id)!;
      return {
        segmentId: s.id,
        segmentLabel: s.label,
        avgViews: agg.count ? agg.viewsSum / agg.count : 0,
        avgErPercent: agg.count ? (agg.erSum / agg.count) * 100 : 0,
      };
    });
  }, [filteredPosts]);

  /** Средние просмотры и ER по типам постов */
  const byPostType = useMemo(() => {
    const map = new Map<
      string,
      { postType: string; viewsSum: number; erSum: number; count: number }
    >();

    filteredPosts.forEach((p) => {
      if (!map.has(p.postType)) {
        map.set(p.postType, {
          postType: p.postType,
          viewsSum: 0,
          erSum: 0,
          count: 0,
        });
      }
      const entry = map.get(p.postType)!;
      entry.viewsSum += p.views;
      entry.erSum += p.er;
      entry.count += 1;
    });

    const items = Array.from(map.values()).map((v) => ({
      postType: v.postType,
      avgViews: v.count > 0 ? v.viewsSum / v.count : 0,
      avgErPercent: v.count > 0 ? (v.erSum / v.count) * 100 : 0,
    }));

    items.sort((a, b) => b.avgViews - a.avgViews);
    return items;
  }, [filteredPosts]);

  /** Heatmap: средние просмотры по (день недели × час) */
  const heatmapData = useMemo(() => {
    const cellMap = new Map<
      string,
      { weekdayIndex: number; weekday: string; hour: number; viewsSum: number; count: number }
    >();

    filteredPosts.forEach((p) => {
      const key = `${p.weekdayIndex}-${p.hour}`;
      if (!cellMap.has(key)) {
        cellMap.set(key, {
          weekdayIndex: p.weekdayIndex,
          weekday: p.weekdayLabel,
          hour: p.hour,
          viewsSum: 0,
          count: 0,
        });
      }
      const cell = cellMap.get(key)!;
      cell.viewsSum += p.views;
      cell.count += 1;
    });

    const cells: {
      weekdayIndex: number;
      weekday: string;
      hour: number;
      avgViews: number;
    }[] = [];

    cellMap.forEach((value) => {
      cells.push({
        weekdayIndex: value.weekdayIndex,
        weekday: value.weekday,
        hour: value.hour,
        avgViews: value.count > 0 ? value.viewsSum / value.count : 0,
      });
    });

    const maxViews = cells.reduce((m, c) => Math.max(m, c.avgViews), 0) || 1;

    return {
      cells,
      maxViews,
    };
  }, [filteredPosts]);

  /** Цвет для heatmap (градиент вокруг A56FFD) */
  const getHeatmapColor = (ratio: number) => {
    if (ratio <= 0) return "#f4f4f5"; // очень светлый серый
    const start = { r: 245, g: 240, b: 255 }; // очень светлый фиолетовый
    const end = { r: 165, g: 111, b: 253 }; // #A56FFD

    const r = Math.round(start.r + (end.r - start.r) * ratio);
    const g = Math.round(start.g + (end.g - start.g) * ratio);
    const b = Math.round(start.b + (end.b - start.b) * ratio);

    return `rgb(${r}, ${g}, ${b})`;
  };

  /** 1) Пока файл не загружен — экран загрузки */
  if (posts.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="chart-card max-w-md w-full">
          <h1 className="text-xl font-semibold mb-2 text-neutral-900 text-center">
            Telegram Media Dashboard
          </h1>
          <p className="text-muted mb-4 text-center">
            Загрузите Excel/CSV с данными постов, чтобы получить аналитику.
          </p>
          <ul className="text-muted mb-4 list-disc list-inside text-xs space-y-1">
            <li><strong>Дата</strong> — дата поста</li>
            <li><strong>Время поста</strong> — время публикации</li>
            <li><strong>Количество просмотров в день поста</strong></li>
            <li><strong>Количество реакций</strong></li>
            <li><strong>Тип поста</strong> — рубрика/формат</li>
            <li><strong>ER (Engagement Rate)</strong> (необязательно) — в %</li>
          </ul>
          <label className="w-full flex justify-center">
            <span className="btn-accent w-full text-center">
              Загрузить файл (.xlsx / .csv)
            </span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      </div>
    );
  }

  /** 2) Файл загружен — полный дашборд */
  return (
    <div className="min-h-screen flex flex-col bg-neutral-50">
      {/* Header */}
      <header className="border-b border-neutral-200 bg-white/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-neutral-900">
              Telegram Media Dashboard
            </h1>
            <p className="text-muted">
              Аналитика ER, просмотров и поведения аудитории по загруженной таблице.
            </p>
          </div>
          <label className="cursor-pointer">
            <span className="btn-accent text-xs md:text-sm">
              Заменить файл
            </span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-4 md:py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[260px,1fr] gap-5 md:gap-6">
          {/* Фильтры */}
          <aside className="space-y-4">
            <div className="chart-card sticky top-24">
              <h2 className="text-sm font-semibold mb-3 text-neutral-900">
                Фильтры
              </h2>

              {/* Месяц */}
              <div className="mb-3">
                <label className="block text-muted mb-1.5">
                  Месяц
                </label>
                <select
                  className="input-field"
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                >
                  <option value="all">За весь период</option>
                  {monthOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              {/* Тип поста */}
              <div className="mb-3">
                <label className="block text-muted mb-1.5">
                  Тип поста
                </label>
                <select
                  className="input-field"
                  value={selectedPostType}
                  onChange={(e) => setSelectedPostType(e.target.value)}
                >
                  <option value="all">Все типы</option>
                  {postTypeOptions.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              {/* День недели */}
              <div className="mb-3">
                <label className="block text-muted mb-1.5">
                  День недели
                </label>
                <select
                  className="input-field"
                  value={selectedWeekday}
                  onChange={(e) => setSelectedWeekday(e.target.value)}
                >
                  <option value="all">Все дни</option>
                  {WEEKDAYS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>

              {/* Инфо по выборке */}
              <div className="mt-4 text-muted border-t border-neutral-200 pt-3 space-y-1">
                <p>
                  Постов в выборке:{" "}
                  <span className="text-neutral-900 font-semibold">
                    {filteredPosts.length}
                  </span>
                </p>
                <p>
                  Всего в базе:{" "}
                  <span className="text-neutral-900 font-semibold">
                    {posts.length}
                  </span>
                </p>
              </div>
            </div>
          </aside>

          {/* Основной контент */}
          <section className="space-y-5 md:space-y-6">
            {/* KPI */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="chart-card">
                <div className="text-muted mb-1.5">
                  Количество постов
                </div>
                <div className="text-xl md:text-2xl font-semibold text-neutral-900">
                  {kpi.totalPosts}
                </div>
              </div>
              <div className="chart-card">
                <div className="text-muted mb-1.5">
                  Средние просмотры
                </div>
                <div className="text-xl md:text-2xl font-semibold text-neutral-900">
                  {kpi.avgViews.toFixed(0)}
                </div>
              </div>
              <div className="chart-card">
                <div className="text-muted mb-1.5">
                  Средние реакции
                </div>
                <div className="text-xl md:text-2xl font-semibold text-neutral-900">
                  {kpi.avgReactions.toFixed(1)}
                </div>
              </div>
              <div className="chart-card">
                <div className="text-muted mb-1.5">
                  Средний ER
                </div>
                <div className="text-xl md:text-2xl font-semibold text-neutral-900">
                  {(kpi.avgEr * 100).toFixed(1)}%
                </div>
              </div>
            </div>

            {/* Графики по времени */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* ER по времени */}
              <div className="chart-card">
                <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                  Изменение ER по времени
                </h3>
                <p className="text-muted mb-3">
                  Как менялась вовлечённость по датам публикации.
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={timeSeriesData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 10 }} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        tickFormatter={(v) => `${v.toFixed(0)}%`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #e5e7eb",
                          fontSize: 12,
                        }}
                        formatter={(value: any) =>
                          `${(value as number).toFixed(1)}%`
                        }
                        labelFormatter={(label) => `Дата: ${label}`}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="erPercent"
                        name="ER, %"
                        stroke="#FF56DD"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Просмотры по времени */}
              <div className="chart-card">
                <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                  Изменение количества просмотров по времени
                </h3>
                <p className="text-muted mb-3">
                  Динамика охвата постов во времени.
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={timeSeriesData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #e5e7eb",
                          fontSize: 12,
                        }}
                        formatter={(value: any) =>
                          (value as number).toFixed(0)
                        }
                        labelFormatter={(label) => `Дата: ${label}`}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="views"
                        name="Просмотры"
                        stroke="#8195FF"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Реакции по времени */}
              <div className="chart-card md:col-span-2">
                <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                  Изменение количества реакций по времени
                </h3>
                <p className="text-muted mb-3">
                  Как меняется активность реакций (лайки, эмодзи) по датам.
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={timeSeriesData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="dateLabel" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #e5e7eb",
                          fontSize: 12,
                        }}
                        formatter={(value: any) =>
                          (value as number).toFixed(1)
                        }
                        labelFormatter={(label) => `Дата: ${label}`}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="reactions"
                        name="Реакции"
                        stroke="#FF5689"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Дни недели */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Просмотры по дням недели */}
              <div className="chart-card">
                <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                  Средние просмотры по дням недели
                </h3>
                <p className="text-muted mb-3">
                  В какие дни недели посты набирают больше всего просмотров.
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={viewsByWeekday}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="weekday" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #e5e7eb",
                          fontSize: 12,
                        }}
                        formatter={(value: any) =>
                          (value as number).toFixed(0)
                        }
                        labelFormatter={(label) =>
                          `День недели: ${label}`
                        }
                      />
                      <Bar
                        dataKey="avgViews"
                        name="Средние просмотры"
                        fill="#8195FF"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* ER по дням недели */}
              <div className="chart-card">
                <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                  Средний ER по дням недели
                </h3>
                <p className="text-muted mb-3">
                  В какие дни недели аудитория вовлекается сильнее.
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={erByWeekday}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="weekday" tick={{ fontSize: 12 }} />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => `${v.toFixed(0)}%`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #e5e7eb",
                          fontSize: 12,
                        }}
                        formatter={(value: any) =>
                          `${(value as number).toFixed(1)}%`
                        }
                        labelFormatter={(label) =>
                          `День недели: ${label}`
                        }
                      />
                      <Bar
                        dataKey="avgErPercent"
                        name="Средний ER, %"
                        fill="#FF56DD"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Типы постов */}
            <div className="chart-card">
              <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                Средние просмотры и ER по типам постов
              </h3>
              <p className="text-muted mb-3">
                Какие форматы (рубрики) работают лучше всего по просмотрам и вовлечённости.
              </p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byPostType} margin={{ left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis
                      dataKey="postType"
                      tick={{ fontSize: 10 }}
                      interval={0}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 10 }}
                      orientation="left"
                    />
                    <YAxis
                      yAxisId="right"
                      tick={{ fontSize: 10 }}
                      orientation="right"
                      tickFormatter={(v) => `${v.toFixed(0)}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#ffffff",
                        border: "1px solid #e5e7eb",
                        fontSize: 12,
                      }}
                      formatter={(value: any, name: any) => {
                        if (name === "Средний ER, %") {
                          return `${(value as number).toFixed(1)}%`;
                        }
                        return (value as number).toFixed(0);
                      }}
                    />
                    <Legend />
                    <Bar
                      yAxisId="left"
                      dataKey="avgViews"
                      name="Средние просмотры"
                      fill="#8195FF"
                    />
                    <Bar
                      yAxisId="right"
                      dataKey="avgErPercent"
                      name="Средний ER, %"
                      fill="#A8DF09"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Зависимость от паузы и времени суток */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Пауза с прошлого поста */}
              <div className="chart-card">
                <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                  Зависимость просмотров и ER от времени с предыдущего поста
                </h3>
                <p className="text-muted mb-3">
                  Показывает, как частота публикаций влияет на охваты и вовлечённость.
                  Пауза считается как время между текущим и прошлым постом.
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={gapStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="bucketLabel"
                        tick={{ fontSize: 10 }}
                        interval={0}
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 10 }}
                        orientation="left"
                      />
                      <YAxis
                        yAxisId="right"
                        tick={{ fontSize: 10 }}
                        orientation="right"
                        tickFormatter={(v) => `${v.toFixed(0)}%`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #e5e7eb",
                          fontSize: 12,
                        }}
                        formatter={(value: any, name: any) => {
                          if (name === "Средний ER, %") {
                            return `${(value as number).toFixed(1)}%`;
                          }
                          return (value as number).toFixed(0);
                        }}
                      />
                      <Legend />
                      <Bar
                        yAxisId="left"
                        dataKey="avgViews"
                        name="Средние просмотры"
                        fill="#8195FF"
                      />
                      <Bar
                        yAxisId="right"
                        dataKey="avgErPercent"
                        name="Средний ER, %"
                        fill="#A8DF09"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Время суток */}
              <div className="chart-card">
                <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                  Просмотры и ER по времени суток
                </h3>
                <p className="text-muted mb-3">
                  Помогает понять, в какие интервалы дня аудитория не только смотрит,
                  но и активнее реагирует на посты.
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={timeOfDayStats}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="segmentLabel"
                        tick={{ fontSize: 10 }}
                        interval={0}
                      />
                      <YAxis
                        yAxisId="left"
                        tick={{ fontSize: 10 }}
                        orientation="left"
                      />
                      <YAxis
                        yAxisId="right"
                        tick={{ fontSize: 10 }}
                        orientation="right"
                        tickFormatter={(v) => `${v.toFixed(0)}%`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#ffffff",
                          border: "1px solid #e5e7eb",
                          fontSize: 12,
                        }}
                        formatter={(value: any, name: any) => {
                          if (name === "Средний ER, %") {
                            return `${(value as number).toFixed(1)}%`;
                          }
                          return (value as number).toFixed(0);
                        }}
                      />
                      <Legend />
                      <Bar
                        yAxisId="left"
                        dataKey="avgViews"
                        name="Средние просмотры"
                        fill="#FF5689"
                      />
                      <Bar
                        yAxisId="right"
                        dataKey="avgErPercent"
                        name="Средний ER, %"
                        fill="#FF56DD"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Heatmap */}
            <div className="chart-card">
              <h3 className="text-sm font-semibold mb-1.5 text-neutral-900">
                Зависимость просмотров от дня недели и времени
              </h3>
              <p className="text-muted mb-3">
                Тепловая карта: по оси Y — день недели, по оси X — час публикации.
                Чем насыщеннее фиолетовый, тем выше средние просмотры.
              </p>
              <div className="overflow-x-auto">
                <div className="min-w-[640px]">
                  <div className="grid grid-cols-[80px_repeat(24,1fr)] gap-[1px] bg-neutral-200 rounded-xl overflow-hidden text-[10px] md:text-xs">
                    {/* Шапка: пустая + часы */}
                    <div className="bg-neutral-50 flex items-center justify-center font-medium text-neutral-700">
                      День / Час
                    </div>
                    {HOURS.map((h) => (
                      <div
                        key={h}
                        className="bg-neutral-50 flex items-center justify-center text-neutral-700"
                      >
                        {h}
                      </div>
                    ))}

                    {/* Строки по дням недели */}
                    {WEEKDAYS.map((weekdayLabel, wIdx) => (
                      <React.Fragment key={weekdayLabel}>
                        <div className="bg-neutral-50 flex items-center justify-center font-medium text-neutral-700">
                          {weekdayLabel}
                        </div>
                        {HOURS.map((hour) => {
                          const cell = heatmapData.cells.find(
                            (c) =>
                              c.weekdayIndex === wIdx && c.hour === hour
                          );
                          const ratio =
                            cell && heatmapData.maxViews > 0
                              ? cell.avgViews / heatmapData.maxViews
                              : 0;

                          const bgColor = getHeatmapColor(ratio);

                          return (
                            <div
                              key={`${weekdayLabel}-${hour}`}
                              className={clsx(
                                "relative h-6 md:h-7 flex items-center justify-center text-[9px] md:text-[10px]",
                                ratio > 0.6 ? "text-neutral-900" : "text-neutral-700"
                              )}
                              style={{ backgroundColor: bgColor }}
                              title={
                                cell
                                  ? `${weekdayLabel}, ${hour}:00 — средние просмотры: ${cell.avgViews.toFixed(
                                      0
                                    )}`
                                  : `${weekdayLabel}, ${hour}:00 — нет данных`
                              }
                            >
                              {cell && cell.avgViews > 0
                                ? cell.avgViews.toFixed(0)
                                : ""}
                            </div>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};

export default App;
