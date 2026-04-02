async function generateResponse(inputId, outputId) {
  const text = document.getElementById(inputId).value.trim();
  if (!text) {
    toast('Type an objection first.');
    return;
  }

  const output = document.getElementById(outputId);
  const toneEl = document.getElementById('toneSelect');
  const langEl = document.getElementById('langSelect');
  const tone = toneEl ? toneEl.value : 'Confident';
  const language = langEl ? langEl.value : 'English';

  const objectionType = detectObjectionType(text);
  objectionCounts[objectionType] = (objectionCounts[objectionType] || 0) + 1;

  output.classList.add('loading');
  output.textContent = 'Generating...';

  // Store user input
  conversationMemory.push({
    role: 'user',
    content: `Supplier said: "${text}"`
  });

  const systemPrompt = buildSystemPrompt(tone, language, objectionType);

  // ✅ FIXED messages array
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationMemory.slice(-6)
  ];

  try {
    const resp = await fetch('/api/generate-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages })
    });

    const data = await resp.json();

    // ✅ SHOW REAL BACKEND ERROR
    if (!resp.ok) {
      console.error('Backend error:', data);
      output.classList.remove('loading');
      output.textContent = data.error || 'Server error';
      toast(data.error || 'Server error');
      return;
    }

    const reply = data.reply || 'Could not generate a response. Please try again.';

    // Save conversation
    conversationMemory.push({ role: 'assistant', content: reply });

    sessionHistory.push({
      objection: text,
      reply,
      type: objectionType,
      tone,
      language,
      time: new Date().toLocaleTimeString()
    });

    lastGeneratedText = reply;

    // Display nicely
    typeText(output, reply);

    updateObjectionInsights();

  } catch (e) {
    console.error('Fetch error:', e);
    output.classList.remove('loading');
    output.textContent = e.message || 'Network error';
    toast(e.message || 'Network error');
  }
}
