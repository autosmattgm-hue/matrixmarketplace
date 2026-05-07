
    // ==============================
    // Payment Status Script
    // ==============================

    // Helper function to read query parameters
    function getQueryParam(param) {
      const urlParams = new URLSearchParams(window.location.search);
      return urlParams.get(param);
    }

    // Main function: Check payment status
    function checkPaymentStatus() {
      let status = MMStorage.getItem("paymentStatus") || "pending";
      const name = MMStorage.getItem("paymentName") || "N/A";
      const amount = MMStorage.getItem("paymentAmount") || "0";
      const plan = MMStorage.getItem("paymentPlan") || "Unknown Plan";

      const titleEl = document.getElementById("statusTitle");
      const messageEl = document.getElementById("statusMessage");
      const nameEl = document.getElementById("detailsName");
      const amountEl = document.getElementById("detailsAmount");
      const planEl = document.getElementById("detailsPlan");
      const btnEl = document.getElementById("continueBtn");

      if (!titleEl || !messageEl) return; // If not on payment page, exit

      nameEl.innerText = name;
      amountEl.innerText = amount + " GMD";
      planEl.innerText = plan;

      // Handle statuses
      if (status === "success") {
        titleEl.innerText = "✅ Payment Accepted";
        messageEl.innerText = "Your payment has been received successfully!";
        messageEl.className = "status-message success";
        btnEl.style.display = "inline-block";

        // Auto redirect after 3s
        setTimeout(() => {
          window.location.href = `code.html?name=${encodeURIComponent(name)}&plan=${encodeURIComponent(plan)}&amount=${amount}`;
        }, 3000);

      } else if (status === "declined") {
        titleEl.innerText = "❌ Payment Declined";
        messageEl.innerText = "Your payment could not be processed. Please try again.";
        messageEl.className = "status-message declined";
        btnEl.style.display = "none";

      } else {
        titleEl.innerText = "⌛ Payment Pending";
        messageEl.innerText = "We are still verifying your payment. Please wait...";
        messageEl.className = "status-message pending";
        btnEl.style.display = "none";
      }
    }

    // Run when page loads
    window.onload = function () {
      checkPaymentStatus();

      // Keep checking every 3 seconds (simulate admin update)
      setInterval(() => {
        if (!document.hidden) checkPaymentStatus();
      }, 3000);
    };
  

    function renderPayments() {
    let requests = JSON.parse(MMStorage.getItem("pendingRequests")) || [];
    let table = document.getElementById("paymentTable");
    if (!table) return;

    table.innerHTML = `
        <tr>
            <th>Name</th>
            <th>Amount</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Action</th>
        </tr>`;

    requests.forEach((req, index) => {
        table.innerHTML += `
            <tr>
                <td>${req.name}</td>
                <td>${req.amount} GMD</td>
                <td>${req.plan}</td>
                <td>${req.status}</td>
                <td>
                    <button class="approve" onclick="updatePayment(${index}, 'success')">✅ Accept</button>
                    <button class="reject" onclick="updatePayment(${index}, 'declined')">❌ Decline</button>
                    <button class="pending" onclick="updatePayment(${index}, 'pending')">⌛ Pending</button>
                </td>
            </tr>`;
    });
}

function updatePayment(index, status) {
    let requests = JSON.parse(MMStorage.getItem("pendingRequests")) || [];
    if (!requests[index]) return;
    requests[index].status = status;
    MMStorage.setItem("pendingRequests", JSON.stringify(requests));

    if (typeof addLog === "function") {
      addLog(`Payment for ${requests[index].name} → ${status.toUpperCase()}`);
    }
    renderPayments();
}

