<%@ page contentType="text/html; charset=UTF-8" pageEncoding="UTF-8" %>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%-- Loaded into <div id="main"> by the SPA router: no doctype/html/head/body --%>
<div class="panel" id="${panelId}">
  <h2>${title}</h2>
  <img src="${ctx}/img/logo.png">
  <center>Obsolete</center>
  <table>
    <c:forEach items="${rows}" var="r">
      <tr><td>${r.name}</td></tr>
    </c:forEach>
    <div>Not allowed here</div>
  </table>
  <li>Outside a list</li>
  <section><div>Unclosed
</div>
