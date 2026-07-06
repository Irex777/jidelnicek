// ═══════════════════════════════════════════════════════════════════════
// Shared utilities
// ═══════════════════════════════════════════════════════════════════════

const DAY_NAMES_CS = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];

function calcBMR(u) {
  if (!u.weight_current || !u.height || !u.age || !u.sex) return 2000;
  return u.sex === 'male'
    ? Math.round(10 * u.weight_current + 6.25 * u.height - 5 * u.age + 5)
    : Math.round(10 * u.weight_current + 6.25 * u.height - 5 * u.age - 161);
}

function calcTDEE(bmr, level) {
  const multipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  return Math.round(bmr * (multipliers[level] || 1.55));
}

function calcCaloriesTarget(u) {
  const bmr = calcBMR(u);
  const tdee = calcTDEE(bmr, u.activity_level || 'moderate');
  return (u.weight_goal && u.weight_current && u.weight_goal < u.weight_current) ? tdee - 500 : tdee;
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function getDayIndex(dateStr) {
  const d = new Date(dateStr);
  const jsDay = d.getDay(); // 0=Sun, 1=Mon...6=Sat
  return jsDay === 0 ? 6 : jsDay - 1; // Convert to 0=Mon...6=Sun
}

function planToJSON(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    date: row.date,
    day_name: row.day_name,
    total_calories: row.total_calories,
    total_protein: row.total_protein,
    total_carbs: row.total_carbs,
    total_fat: row.total_fat,
    meals: JSON.parse(row.meals_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  DAY_NAMES_CS,
  calcBMR,
  calcTDEE,
  calcCaloriesTarget,
  getWeekStart,
  addDays,
  getDayIndex,
  planToJSON,
};
