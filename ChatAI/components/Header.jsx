import {
  Container,
  Navbar,
   Col,
  Row,
  Image,
} from "react-bootstrap";

export default function Header() {
  return (
<Navbar sticky="top" className="navbar">
  <Container>
    <Row className="align-items-center">
      <Col >
        <Image
          id="avatar"
          src="../dist/assets/pi.jpeg"
          width="100px"
          alt="avatar image"
        />
      </Col>
      <Col xs="auto">
        <h1 className="ml-3 mb-0">AI Assistant</h1>
      </Col>
    </Row>
  </Container>
</Navbar>
  );
}
