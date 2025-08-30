let page = 0;
const limit = 10;
const reloadBtn = document.getElementById('reload-btn');
reloadBtn.addEventListener('click', () => location.reload());

function loadMetrics() {
  fetch('/api/metrics')
    .then(res => res.json())
    .then(data => {
      document.getElementById('active-conversations').innerText = `Conversas Ativas: ${data.activeConversations}`;
      document.getElementById('total-contatos').innerText = `Total de Contatos: ${data.totalContatos}`;
      document.getElementById('messages-received').innerText = `Mensagens Recebidas: ${data.messagesReceived}`;
      document.getElementById('messages-sent').innerText = `Mensagens Enviadas: ${data.messagesSent}`;

      const ctx = document.getElementById('stages-chart').getContext('2d');
      new Chart(ctx, {
        type: 'pie',
        data: {
          labels: Object.keys(data.stages),
          datasets: [{
            data: Object.values(data.stages),
            backgroundColor: ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40']
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'top' } }
        }
      });
    })
    .catch(err => console.error('Erro ao carregar métricas:', err));
}

function loadContacts(append = false) {
  fetch(`/api/contatos?page=${page}&limit=${limit}`)
    .then(res => res.json())
    .then(data => {
      const list = document.getElementById('contacts-list');
      if (!append) list.innerHTML = '';
      data.forEach(contact => {
        const div = document.createElement('div');
        div.classList.add('contact');
        div.innerHTML = `<strong>${contact.id}</strong> - Etapa: ${contact.etapa_atual} - Última: ${new Date(contact.ultima_interacao).toLocaleString()}`;
        div.onclick = () => loadChat(contact.id);
        list.appendChild(div);
      });
      if (data.length === limit) page++;
    })
    .catch(err => console.error('Erro ao carregar contatos:', err));
}

function loadChat(id) {
  fetch(`/api/chat/${id}`)
    .then(res => res.json())
    .then(data => {
      const view = document.getElementById('chat-view');
      view.innerHTML = '';
      data.forEach(msg => {
        const div = document.createElement('div');
        div.classList.add('message', msg.role === 'sent' ? 'sent' : 'received');
        div.innerHTML = `<small>${new Date(msg.data).toLocaleString()}</small><br>${msg.mensagem || msg.mensagem}`;
        view.appendChild(div);
      });
      view.scrollTop = view.scrollHeight;
    })
    .catch(err => console.error('Erro ao carregar chat:', err));
}

document.getElementById('contacts-list').addEventListener('scroll', function() {
  if (this.scrollTop + this.clientHeight >= this.scrollHeight - 20) {
    loadContacts(true);
  }
});

loadMetrics();
loadContacts();