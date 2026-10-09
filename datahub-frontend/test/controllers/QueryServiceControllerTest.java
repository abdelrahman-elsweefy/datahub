package controllers;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.typesafe.config.ConfigFactory;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import play.libs.Json;
import play.mvc.Http;

public class QueryServiceControllerTest {
  private static final String SECRET = "test-proxy-secret-with-at-least-32-characters";
  private static final String ACTOR = "urn:li:corpuser:user1";

  private QueryServiceController controller(HttpClient client) {
    return new QueryServiceController(
        client,
        ConfigFactory.parseMap(
            Map.of(
                "queryService.endpoint",
                "http://query-service:9004",
                "queryService.proxySecret",
                SECRET)));
  }

  private Http.Request request(boolean signedIn) {
    Http.RequestBuilder builder =
        new Http.RequestBuilder()
            .method("POST")
            .uri("/query-service/v1/query")
            .bodyJson(Json.parse("{\"connectionId\":\"analytics\",\"sql\":\"SELECT 1\"}"))
            .header("X-DataHub-Query-Actor", "urn:li:corpuser:forged")
            .header("X-DataHub-Query-Signature", "forged");
    if (signedIn) {
      builder
          .session(Map.of("actor", ACTOR, "token", "test-token"))
          .cookie(Http.Cookie.builder("actor", ACTOR).build());
    }
    return builder.build();
  }

  @Test
  public void rejectsRequestsWithoutAValidSession() throws Exception {
    HttpClient client = mock(HttpClient.class);
    assertEquals(401, controller(client).query(request(false)).get().status());
    verifyNoInteractions(client);
  }

  @Test
  @SuppressWarnings("unchecked")
  public void signsTheSessionIdentityAndPreservesTheServiceStatus() throws Exception {
    HttpClient client = mock(HttpClient.class);
    HttpResponse<byte[]> response = mock(HttpResponse.class);
    when(response.statusCode()).thenReturn(403);
    when(response.body()).thenReturn("{}".getBytes());
    when(client.sendAsync(any(HttpRequest.class), any(HttpResponse.BodyHandler.class)))
        .thenReturn(CompletableFuture.completedFuture(response));
    assertEquals(403, controller(client).query(request(true)).get().status());
    ArgumentCaptor<HttpRequest> forwarded = ArgumentCaptor.forClass(HttpRequest.class);
    verify(client).sendAsync(forwarded.capture(), any(HttpResponse.BodyHandler.class));
    assertEquals("http://query-service:9004/v1/query", forwarded.getValue().uri().toString());
    assertEquals(
        ACTOR, forwarded.getValue().headers().firstValue("X-DataHub-Query-Actor").orElseThrow());
    assertEquals(
        "Bearer test-token",
        forwarded.getValue().headers().firstValue("Authorization").orElseThrow());
    assertNotEquals(
        "forged",
        forwarded.getValue().headers().firstValue("X-DataHub-Query-Signature").orElseThrow());
  }

  @Test
  public void reportsAnUnavailableServiceWithoutLeakingTheFailure() throws Exception {
    HttpClient client = mock(HttpClient.class);
    when(client.sendAsync(any(HttpRequest.class), any(HttpResponse.BodyHandler.class)))
        .thenReturn(
            CompletableFuture.failedFuture(new RuntimeException("internal connection details")));
    assertEquals(503, controller(client).query(request(true)).get().status());
  }
}
