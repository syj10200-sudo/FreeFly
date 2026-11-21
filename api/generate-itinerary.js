/**
 * FreeFLY AI itinerary endpoint for Vercel.
 * Requires OPENAI_API_KEY environment variable.
 * IMPORTANT: configure persistent rate limiting before public launch.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, payload) => res.status(status).json(payload);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(405, { error: 'POST 요청만 지원합니다.' });
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) return send(503, { error: 'AI 서버 설정이 완료되지 않았습니다. 운영자에게 문의해 주세요.' });

  let data = req.body;
  try {
    if (typeof data === 'string') data = JSON.parse(data);
    if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 4096) throw new Error('invalid request');
  } catch (_) {
    return send(400, { error: '요청 형식이 잘못되었습니다.' });
  }
  const allowed = {
    gender: ['남성', '여성', '응답 안 함'],
    age: ['10대', '20대', '30대', '40대', '50대', '60대 이상'],
    relationship: ['커플', '가족', '친구', '동성 친구', '단체', '회사', '혼자'],
    people: ['1명', '2명', '3명', '4명', '5명 이상'],
    styles: ['액티비티', '맛집투어', '자연경관', '로컬투어', '문화·역사', '휴양·힐링']
  };
  const destination = typeof data.destination === 'string' ? data.destination.trim() : '';
  if (!destination || destination.length > 90) return send(400, { error: '여행지를 올바르게 입력해 주세요.' });
  for (const field of ['gender', 'age', 'relationship', 'people']) {
    if (!allowed[field].includes(data[field])) return send(400, { error: '여행 조건에 잘못된 항목이 있습니다.' });
  }
  if (!Array.isArray(data.styles) || data.styles.length < 1 || data.styles.length > 3 ||
      new Set(data.styles).size !== data.styles.length ||
      !data.styles.every((style) => allowed.styles.includes(style))) {
    return send(400, { error: '여행 방향은 1~3개 선택해 주세요.' });
  }
  if (data.relationship === '혼자' && data.people !== '1명') {
    return send(400, { error: '혼자 여행을 선택했다면 인원을 1명으로 설정해 주세요.' });
  }

  function parseISODate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(value + 'T12:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
  }
  const start = parseISODate(data.startDate);
  const end = parseISODate(data.endDate);
  const days = start === null || end === null ? 0 : Math.round((end - start) / 86400000) + 1;
  if (days < 1 || days > 14) return send(400, { error: '여행 날짜를 확인해 주세요. 최대 14일까지 가능합니다.' });

  const systemPrompt = [
    '당신은 FreeFLY의 여행 일정 기획자입니다. 반드시 한국어로 작성합니다.',
    '여행지·동행 관계·인원·연령대·성별·여행 방향·날짜를 모두 고려하되 성별이나 연령에 관한 고정관념으로 판단하지 마십시오.',
    '가까운 지역끼리 묶어 이동 동선을 단순화하고 체력적 부담과 휴식, 식사 시간을 고려하십시오.',
    '항공편 시간과 숙소 위치를 모르므로 첫날 및 귀국일 일정은 유연하게 조정할 수 있도록 작성하십시오.',
    '각 날짜의 오전·점심·오후·저녁 일정과 여행 테마, 이동·예약 유의사항을 구체적으로 작성하십시오.',
    '영업시간, 휴무일, 요금, 교통편, 예약 가능 여부를 실시간 확인한 것처럼 단정하지 마십시오.',
    '실시간 영업 정보는 조회하지 못한다는 점을 verificationNotice에 명확히 적으십시오.',
    '반드시 JSON 객체만 반환하십시오. 형식: {"title":"여행 제목","summary":"1~2문장 소개","verificationNotice":"공식 정보 확인 안내","days":[{"date":"YYYY-MM-DD","label":"하루 테마","morning":"오전 일정","lunch":"점심 일정","afternoon":"오후 일정","evening":"저녁 일정","notes":"이동 및 예약 확인 사항"}]}.',
    'days 배열은 요청 기간의 모든 날짜를 정확히 하루씩, 빠짐없이 날짜순으로 포함해야 합니다.'
  ].join('\n');
  const userPrompt = JSON.stringify({
    destination, gender: data.gender, age: data.age,
    relationship: data.relationship, people: data.people, styles: data.styles,
    startDate: data.startDate, endDate: data.endDate, expectedDays: days
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        response_format: { type: 'json_object' },
        max_tokens: 5200,
        temperature: 0.6
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      console.error('FreeFLY AI service status:', response.status);
      if (response.status === 429) return send(503, { error: '현재 AI 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
      return send(502, { error: 'AI 서비스를 호출하지 못했습니다. 운영자에게 문의해 주세요.' });
    }
    const body = await response.json();
    const message = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    if (!message) throw new Error('empty model response');
    const plan = JSON.parse(message);
    if (!plan || !Array.isArray(plan.days) || plan.days.length !== days ||
        !plan.days.every((day, idx) => {
          const expected = new Date(start + idx * 86400000).toISOString().slice(0, 10);
          return day && day.date === expected &&
            ['label', 'morning', 'lunch', 'afternoon', 'evening'].every((key) => typeof day[key] === 'string' && day[key].trim());
        })) throw new Error('invalid itinerary response');

    return send(200, { plan: {
      title: String(plan.title || destination + ' 여행 일정').slice(0, 140),
      summary: String(plan.summary || '').slice(0, 900),
      verificationNotice: 'AI 일정 초안입니다. 실제 영업시간, 휴무일, 요금, 교통편 및 예약 가능 여부는 공식 사이트에서 반드시 확인하세요.',
      days: plan.days.map((day) => ({
        date: day.date, label: String(day.label).slice(0, 120),
        morning: String(day.morning).slice(0, 1200), lunch: String(day.lunch).slice(0, 1200),
        afternoon: String(day.afternoon).slice(0, 1200), evening: String(day.evening).slice(0, 1200),
        notes: String(day.notes || '').slice(0, 1200)
      }))
    } });
  } catch (error) {
    console.error('FreeFLY AI itinerary error:', error && error.name || 'unknown');
    return send(error && error.name === 'AbortError' ? 504 : 502, {
      error: error && error.name === 'AbortError'
        ? '응답 시간이 초과되었습니다. 다시 시도해 주세요.'
        : 'AI 일정 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.'
    });
  } finally {
    clearTimeout(timeout);
  }
};
