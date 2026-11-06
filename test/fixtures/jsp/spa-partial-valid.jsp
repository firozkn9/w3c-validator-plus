<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt" %>
<%@ taglib prefix="fn" uri="http://java.sun.com/jsp/jstl/functions" %>
<form action="<c:url value='/save'/>" method="post">
  <label for="${fieldId}"><fmt:message key="name"/></label>
  <input type="${inputType}" id="${fieldId}" name="name" value="${fn:escapeXml(user.name)}">
  <input type="hidden" id="${tokenId}" name="token" value="<%= token %>">
  <select name="s">
    <c:forEach items="${opts}" var="o">
      <option value="${o.id}" ${o.id == sel ? 'selected' : ''}>${o.label}</option>
    </c:forEach>
  </select>
  <p style="color: ${color}">${message}</p>
  <img src="<c:url value='/logo.png'/>" alt="${altText}" width="${w}">
  <% if (admin) { %>
    <button type="submit">Save</button>
  <% } %>
</form>
