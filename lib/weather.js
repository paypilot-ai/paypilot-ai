// Current weather in Charlotte, NC (Brandy's home base), so her small talk is
// true instead of made up. Free Open-Meteo API, no key. Cached 15 minutes;
// if it's slow or down the call just goes ahead without it.
const URL = 'https://api.open-meteo.com/v1/forecast?latitude=35.2271&longitude=-80.8431'
  + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
  + '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1'
  + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York';

const CODES = {
  0: 'clear skies', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'foggy', 51: 'light drizzle', 53: 'drizzly', 55: 'heavy drizzle',
  61: 'light rain', 63: 'raining', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snowing', 75: 'heavy snow', 77: 'snow flurries',
  80: 'rain showers', 81: 'rain showers', 82: 'heavy downpours', 85: 'snow showers', 86: 'snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail',
};

let cache = { at: 0, text: '' };

async function charlotteWeather() {
  if (cache.text && Date.now() - cache.at < 15 * 60 * 1000) return cache.text;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(URL, { signal: ctrl.signal });
    if (!r.ok) return '';
    const d = await r.json();
    const c = d.current || {};
    const day = d.daily || {};
    const sky = CODES[c.weather_code] || 'mixed weather';
    const t = Math.round(c.temperature_2m);
    const feels = Math.round(c.apparent_temperature);
    const hi = day.temperature_2m_max && Math.round(day.temperature_2m_max[0]);
    const lo = day.temperature_2m_min && Math.round(day.temperature_2m_min[0]);
    let text = `${t}°F and ${sky} right now`;
    if (Math.abs(feels - t) >= 4) text += `, feels like ${feels}°F`;
    if (hi && lo) text += `. Today's high ${hi}°F, low ${lo}°F`;
    if (c.wind_speed_10m >= 15) text += `, and windy`;
    cache = { at: Date.now(), text };
    return text;
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { charlotteWeather };
