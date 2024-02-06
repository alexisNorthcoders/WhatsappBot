import './App.css'
import Footer from '../components/Footer';
import Header from '../components/Header';
import { Container ,Row,Col} from 'react-bootstrap';
import MainBody from '../components/MainBody';
import "bootstrap/dist/css/bootstrap.min.css";

function App() {
  

  return (<Container><Col>
    <Row className="header"><Header/></Row> 
   <Row className="mainbody"> <MainBody/></Row>
   <Row className="footer"><Footer/></Row>
   </Col>
   </Container>
  )
}

export default App
